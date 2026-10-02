use crate::{
    CodeWorkspaceCatalogDiagnostics, CodeWorkspaceFolderDiagnostics, CodeWorkspaceFolderImport,
    CodeWorkspaceFolderStatus, CodeWorkspaceImportDiagnostics, CodeWorkspaceImportRequest,
    CodeWorkspaceImportResult, CodeWorkspaceImportWarning, CodeWorkspaceImportWarningCode,
    CodeWorkspaceMatchAttempt, CodeWorkspaceMatchCandidate, CodeWorkspaceResolutionBasis,
    CodeWorkspaceResolutionReason, RepositoryCatalog, RepositorySummary,
};
use serde_json::{Map, Value};
use std::collections::BTreeSet;
use wts_core::workspace::{MAX_REPOSITORY_SET_LABEL_CHARS, WorkspaceRepositoryRequest};

pub(crate) const MAX_CODE_WORKSPACE_CONTENT_BYTES: usize = 48 * 1024;
const MAX_CODE_WORKSPACE_FILE_NAME_BYTES: usize = 255;
const MAX_CODE_WORKSPACE_FOLDERS: usize = 32;
const MAX_CODE_WORKSPACE_FOLDER_NAME_CHARS: usize = 255;
const MAX_CODE_WORKSPACE_PATH_BYTES: usize = 4096;
const MAX_CODE_WORKSPACE_DIAGNOSTIC_CANDIDATES: usize = 8;
const MAX_CODE_WORKSPACE_DIAGNOSTIC_CATALOG_REPOSITORIES: usize = 16;
const CODE_WORKSPACE_SUFFIX: &str = ".code-workspace";
const UNSUPPORTED_URI_PLACEHOLDER: &str = "<unsupported-uri>";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CodeWorkspaceImportError {
    Invalid,
    TooLarge,
}

pub(crate) fn import_code_workspace(
    mut request: CodeWorkspaceImportRequest,
    catalog: &RepositoryCatalog,
) -> Result<CodeWorkspaceImportResult, CodeWorkspaceImportError> {
    let import_id = request.ensure_import_id();
    let file_name = validate_file_name(&request.file_name)?;
    if request.contents.len() > MAX_CODE_WORKSPACE_CONTENT_BYTES {
        return Err(CodeWorkspaceImportError::TooLarge);
    }

    let contents = request
        .contents
        .strip_prefix('\u{feff}')
        .unwrap_or(&request.contents);
    let parsed: Value = json5::from_str(contents).map_err(|_| CodeWorkspaceImportError::Invalid)?;
    let object = parsed
        .as_object()
        .ok_or(CodeWorkspaceImportError::Invalid)?;
    let raw_folders = object
        .get("folders")
        .and_then(Value::as_array)
        .ok_or(CodeWorkspaceImportError::Invalid)?;
    if raw_folders.len() > MAX_CODE_WORKSPACE_FOLDERS {
        return Err(CodeWorkspaceImportError::Invalid);
    }

    let suggested_title = suggested_title(&file_name)?;
    let suggested_repository_set_label = truncate_chars(
        &format!("VS Code · {suggested_title}"),
        MAX_REPOSITORY_SET_LABEL_CHARS,
    );
    let mut warnings = Vec::new();
    if object.keys().any(|key| key != "folders") {
        warnings.push(CodeWorkspaceImportWarning {
            code: CodeWorkspaceImportWarningCode::ConfigurationIgnored,
            message: "VS Code configuration is not copied into the new WTS workspace.".to_owned(),
            folder_name: None,
        });
    }

    let mut folders = Vec::with_capacity(raw_folders.len());
    let mut folder_diagnostics = Vec::with_capacity(raw_folders.len());
    let mut repositories = Vec::new();
    let mut selected_repository_ids = BTreeSet::new();
    for (index, value) in raw_folders.iter().enumerate() {
        let parsed_folder = parse_folder(value, index)?;
        let folder_name = parsed_folder.name.clone();
        match parsed_folder.kind {
            ParsedFolderKind::Unsupported(message) => {
                warnings.push(folder_warning(
                    CodeWorkspaceImportWarningCode::FolderUnsupported,
                    &folder_name,
                    &message,
                ));
                folders.push(unmatched_folder(
                    parsed_folder.name,
                    parsed_folder.raw_path,
                    CodeWorkspaceFolderStatus::Unsupported,
                    message,
                ));
                folder_diagnostics.push(CodeWorkspaceFolderDiagnostics {
                    folder_index: bounded_count(index),
                    status: CodeWorkspaceFolderStatus::Unsupported,
                    reason: CodeWorkspaceResolutionReason::UnsupportedFolder,
                    resolution_basis: None,
                    attempts: Vec::new(),
                    candidates: Vec::new(),
                    candidates_truncated: false,
                    duplicate_repository: false,
                });
            }
            ParsedFolderKind::Path => {
                let RepositoryResolution {
                    outcome,
                    reason,
                    resolution_basis,
                    attempts,
                    candidates,
                    candidates_truncated,
                } = match_repository(
                    &parsed_folder.raw_path,
                    parsed_folder.explicit_name.as_deref(),
                    catalog,
                );
                match outcome {
                    RepositoryMatch::Matched(repository) => {
                        let duplicate = !selected_repository_ids.insert(repository.id.clone());
                        if duplicate {
                            warnings.push(folder_warning(
                                CodeWorkspaceImportWarningCode::DuplicateRepository,
                                &folder_name,
                                "This repository was already selected by another workspace folder.",
                            ));
                        } else {
                            repositories.push(WorkspaceRepositoryRequest {
                                repository_id: Some(repository.id.clone()),
                                label: repository.label.clone(),
                                base_ref: repository.default_branch.name.clone(),
                            });
                        }
                        folders.push(CodeWorkspaceFolderImport {
                            name: parsed_folder.name,
                            raw_path: parsed_folder.raw_path,
                            status: CodeWorkspaceFolderStatus::Matched,
                            repository_id: Some(repository.id.clone()),
                            repository_label: Some(repository.label.clone()),
                            repository_display_path: Some(repository.display_path.clone()),
                            base_ref: Some(repository.default_branch.name.clone()),
                            message: duplicate.then(|| {
                                "This repository was already selected by another workspace folder."
                                    .to_owned()
                            }),
                        });
                        folder_diagnostics.push(CodeWorkspaceFolderDiagnostics {
                            folder_index: bounded_count(index),
                            status: CodeWorkspaceFolderStatus::Matched,
                            reason,
                            resolution_basis,
                            attempts,
                            candidates,
                            candidates_truncated,
                            duplicate_repository: duplicate,
                        });
                    }
                    RepositoryMatch::Missing => {
                        let message =
                            "No repository in the local catalog matches this workspace folder."
                                .to_owned();
                        warnings.push(folder_warning(
                            CodeWorkspaceImportWarningCode::FolderMissing,
                            &folder_name,
                            &message,
                        ));
                        folders.push(unmatched_folder(
                            parsed_folder.name,
                            parsed_folder.raw_path,
                            CodeWorkspaceFolderStatus::Missing,
                            message,
                        ));
                        folder_diagnostics.push(CodeWorkspaceFolderDiagnostics {
                            folder_index: bounded_count(index),
                            status: CodeWorkspaceFolderStatus::Missing,
                            reason,
                            resolution_basis,
                            attempts,
                            candidates,
                            candidates_truncated,
                            duplicate_repository: false,
                        });
                    }
                    RepositoryMatch::Ambiguous => {
                        let message =
                            "More than one catalog repository matches this workspace folder."
                                .to_owned();
                        warnings.push(folder_warning(
                            CodeWorkspaceImportWarningCode::FolderAmbiguous,
                            &folder_name,
                            &message,
                        ));
                        folders.push(unmatched_folder(
                            parsed_folder.name,
                            parsed_folder.raw_path,
                            CodeWorkspaceFolderStatus::Ambiguous,
                            message,
                        ));
                        folder_diagnostics.push(CodeWorkspaceFolderDiagnostics {
                            folder_index: bounded_count(index),
                            status: CodeWorkspaceFolderStatus::Ambiguous,
                            reason,
                            resolution_basis,
                            attempts,
                            candidates,
                            candidates_truncated,
                            duplicate_repository: false,
                        });
                    }
                }
            }
        }
    }

    let diagnostics = cfg!(debug_assertions).then(|| {
        let repositories: Vec<_> = catalog
            .repositories
            .iter()
            .take(MAX_CODE_WORKSPACE_DIAGNOSTIC_CATALOG_REPOSITORIES)
            .map(repository_candidate)
            .collect();
        CodeWorkspaceImportDiagnostics {
            catalog: CodeWorkspaceCatalogDiagnostics {
                repository_root_display_path: catalog.repository_root_display_path.clone(),
                repository_count: bounded_count(catalog.repositories.len()),
                skipped_entries: catalog.skipped_entries,
                repositories_truncated: catalog.repositories.len() > repositories.len(),
                repositories,
            },
            folders: folder_diagnostics,
        }
    });

    Ok(CodeWorkspaceImportResult {
        import_id,
        file_name,
        suggested_title,
        suggested_repository_set_label,
        folders,
        repositories,
        warnings,
        diagnostics,
    })
}

struct ParsedFolder {
    name: String,
    explicit_name: Option<String>,
    raw_path: String,
    kind: ParsedFolderKind,
}

enum ParsedFolderKind {
    Path,
    Unsupported(String),
}

fn parse_folder(value: &Value, index: usize) -> Result<ParsedFolder, CodeWorkspaceImportError> {
    match value {
        Value::String(path) => parsed_path_folder(None, path, index),
        Value::Object(object) => parse_folder_object(object, index),
        _ => Ok(unsupported_folder(
            format!("Folder {}", index + 1),
            String::new(),
            "This workspace folder entry is not a supported path.",
        )),
    }
}

fn parse_folder_object(
    object: &Map<String, Value>,
    index: usize,
) -> Result<ParsedFolder, CodeWorkspaceImportError> {
    let name = match object.get("name") {
        Some(Value::String(name)) => match validate_folder_name(name) {
            Some(name) if is_uri_shaped_path(&name) => None,
            Some(name) => Some(name),
            None => {
                return Ok(unsupported_folder(
                    format!("Folder {}", index + 1),
                    raw_path_from_object(object)?,
                    "This workspace folder has an invalid display name.",
                ));
            }
        },
        Some(_) => {
            return Ok(unsupported_folder(
                format!("Folder {}", index + 1),
                raw_path_from_object(object)?,
                "This workspace folder has an invalid display name.",
            ));
        }
        None => None,
    };

    match object.get("path") {
        Some(Value::String(path)) => parsed_path_folder(name, path, index),
        Some(_) => Ok(unsupported_folder(
            name.unwrap_or_else(|| format!("Folder {}", index + 1)),
            String::new(),
            "This workspace folder path is not a string.",
        )),
        None => {
            let contains_uri = object.contains_key("uri");
            let raw_path = raw_path_from_object(object)?;
            let fallback_name = name
                .clone()
                .filter(|name| !contains_uri || !is_uri_shaped_path(name))
                .or_else(|| {
                    (!contains_uri)
                        .then(|| workspace_basename(&raw_path).map(bounded_folder_name))
                        .flatten()
                })
                .unwrap_or_else(|| format!("Folder {}", index + 1));
            Ok(unsupported_folder(
                fallback_name,
                raw_path,
                if contains_uri {
                    "URI-based VS Code workspace folders are not supported."
                } else {
                    "This workspace folder does not contain a path."
                },
            ))
        }
    }
}

fn raw_path_from_object(object: &Map<String, Value>) -> Result<String, CodeWorkspaceImportError> {
    for key in ["path", "uri"] {
        if let Some(Value::String(value)) = object.get(key) {
            validate_path_length(value)?;
            if key == "uri" || is_uri_shaped_path(value) {
                return Ok(UNSUPPORTED_URI_PLACEHOLDER.to_owned());
            }
            return Ok(value.to_owned());
        }
    }
    if object.contains_key("uri") {
        return Ok(UNSUPPORTED_URI_PLACEHOLDER.to_owned());
    }
    Ok(String::new())
}

fn parsed_path_folder(
    name: Option<String>,
    path: &str,
    index: usize,
) -> Result<ParsedFolder, CodeWorkspaceImportError> {
    let path = validate_path_length(path)?.to_owned();
    if is_uri_shaped_path(&path) {
        return Ok(unsupported_folder(
            name.filter(|name| !is_uri_shaped_path(name))
                .unwrap_or_else(|| format!("Folder {}", index + 1)),
            UNSUPPORTED_URI_PLACEHOLDER.to_owned(),
            "URI-based VS Code workspace folders are not supported.",
        ));
    }
    let fallback_name = name
        .clone()
        .or_else(|| workspace_basename(&path).map(bounded_folder_name))
        .unwrap_or_else(|| format!("Folder {}", index + 1));
    if path.trim().is_empty() || path.chars().any(char::is_control) {
        return Ok(unsupported_folder(
            fallback_name,
            path,
            "This workspace folder path is empty or contains control characters.",
        ));
    }
    Ok(ParsedFolder {
        name: fallback_name,
        explicit_name: name,
        raw_path: path,
        kind: ParsedFolderKind::Path,
    })
}

fn is_uri_shaped_path(path: &str) -> bool {
    let path = path.trim_start();
    let Some((scheme, remainder)) = path.split_once(':') else {
        return false;
    };
    let mut characters = scheme.chars();
    let valid_scheme = matches!(
        characters.next(),
        Some(first) if first.is_ascii_alphabetic()
    ) && characters
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '+' | '-' | '.'));
    if !valid_scheme {
        return false;
    }

    let windows_drive_absolute =
        scheme.len() == 1 && matches!(remainder.as_bytes().first(), Some(b'/' | b'\\'));
    !windows_drive_absolute
}

fn unsupported_folder(name: String, raw_path: String, message: &str) -> ParsedFolder {
    ParsedFolder {
        name,
        explicit_name: None,
        raw_path,
        kind: ParsedFolderKind::Unsupported(message.to_owned()),
    }
}

fn validate_folder_name(name: &str) -> Option<String> {
    let name = name.trim();
    if name.is_empty()
        || name.chars().count() > MAX_CODE_WORKSPACE_FOLDER_NAME_CHARS
        || name.chars().any(char::is_control)
    {
        return None;
    }
    Some(name.to_owned())
}

fn validate_path_length(path: &str) -> Result<&str, CodeWorkspaceImportError> {
    if path.len() > MAX_CODE_WORKSPACE_PATH_BYTES {
        return Err(CodeWorkspaceImportError::Invalid);
    }
    Ok(path)
}

fn validate_file_name(value: &str) -> Result<String, CodeWorkspaceImportError> {
    let file_name = value.trim();
    if file_name.is_empty()
        || file_name.len() > MAX_CODE_WORKSPACE_FILE_NAME_BYTES
        || file_name.contains(['/', '\\'])
        || file_name.chars().any(char::is_control)
        || !file_name
            .to_ascii_lowercase()
            .ends_with(CODE_WORKSPACE_SUFFIX)
    {
        return Err(CodeWorkspaceImportError::Invalid);
    }
    Ok(file_name.to_owned())
}

fn suggested_title(file_name: &str) -> Result<String, CodeWorkspaceImportError> {
    let stem_length = file_name.len() - CODE_WORKSPACE_SUFFIX.len();
    let title = file_name[..stem_length].trim();
    if title.is_empty() {
        return Err(CodeWorkspaceImportError::Invalid);
    }
    Ok(title.to_owned())
}

fn truncate_chars(value: &str, maximum: usize) -> String {
    value.chars().take(maximum).collect()
}

enum RepositoryMatch<'a> {
    Matched(&'a RepositorySummary),
    Missing,
    Ambiguous,
}

struct RepositoryResolution<'a> {
    outcome: RepositoryMatch<'a>,
    reason: CodeWorkspaceResolutionReason,
    resolution_basis: Option<CodeWorkspaceResolutionBasis>,
    attempts: Vec<CodeWorkspaceMatchAttempt>,
    candidates: Vec<CodeWorkspaceMatchCandidate>,
    candidates_truncated: bool,
}

// Matching stays catalog-only. Relative paths are deliberately not resolved
// against the selected file because browser transports never receive its
// absolute location.
fn match_repository<'a>(
    raw_path: &str,
    explicit_name: Option<&str>,
    catalog: &'a RepositoryCatalog,
) -> RepositoryResolution<'a> {
    let mut attempts = Vec::with_capacity(4);
    if is_absolute_workspace_path(raw_path) {
        let exact: Vec<_> = catalog
            .repositories
            .iter()
            .filter(|repository| repository_matches_exact_path(repository, raw_path))
            .collect();
        attempts.push(match_attempt(
            CodeWorkspaceResolutionBasis::AbsolutePath,
            raw_path,
            exact.len(),
        ));
        match exact.as_slice() {
            [repository] => {
                let repository = *repository;
                return resolution(
                    RepositoryMatch::Matched(repository),
                    CodeWorkspaceResolutionReason::MatchedExactPath,
                    Some(CodeWorkspaceResolutionBasis::AbsolutePath),
                    attempts,
                    exact,
                );
            }
            [_, ..] => {
                return resolution(
                    RepositoryMatch::Ambiguous,
                    CodeWorkspaceResolutionReason::AmbiguousExactPath,
                    Some(CodeWorkspaceResolutionBasis::AbsolutePath),
                    attempts,
                    exact,
                );
            }
            [] => {}
        }
    }

    if let Some(components) = relative_path_suffix_components(raw_path) {
        let normalized_path = components.join("/");
        let candidates = relative_path_suffix_candidates(&components, catalog);
        attempts.push(match_attempt(
            CodeWorkspaceResolutionBasis::RelativePathSuffix,
            &normalized_path,
            candidates.len(),
        ));
        match candidates.as_slice() {
            [repository] => {
                let repository = *repository;
                return resolution(
                    RepositoryMatch::Matched(repository),
                    CodeWorkspaceResolutionReason::MatchedRelativePathSuffix,
                    Some(CodeWorkspaceResolutionBasis::RelativePathSuffix),
                    attempts,
                    candidates,
                );
            }
            [_, ..] => {
                return resolution(
                    RepositoryMatch::Ambiguous,
                    CodeWorkspaceResolutionReason::AmbiguousRelativePathSuffix,
                    Some(CodeWorkspaceResolutionBasis::RelativePathSuffix),
                    attempts,
                    candidates,
                );
            }
            [] => {}
        }
    }

    if let Some(basename) = workspace_basename(raw_path) {
        let candidates = path_basename_candidates(basename, catalog);
        attempts.push(match_attempt(
            CodeWorkspaceResolutionBasis::PathBasename,
            basename,
            candidates.len(),
        ));
        match candidates.as_slice() {
            [repository] => {
                let repository = *repository;
                return resolution(
                    RepositoryMatch::Matched(repository),
                    CodeWorkspaceResolutionReason::MatchedPathBasename,
                    Some(CodeWorkspaceResolutionBasis::PathBasename),
                    attempts,
                    candidates,
                );
            }
            [_, ..] => {
                return resolution(
                    RepositoryMatch::Ambiguous,
                    CodeWorkspaceResolutionReason::AmbiguousPathBasename,
                    Some(CodeWorkspaceResolutionBasis::PathBasename),
                    attempts,
                    candidates,
                );
            }
            [] => {}
        }
    }

    if let Some(name) = explicit_name {
        let candidates = label_candidates(name, catalog);
        attempts.push(match_attempt(
            CodeWorkspaceResolutionBasis::ExplicitName,
            name,
            candidates.len(),
        ));
        match candidates.as_slice() {
            [repository] => {
                return resolution(
                    RepositoryMatch::Matched(repository),
                    CodeWorkspaceResolutionReason::MatchedExplicitName,
                    Some(CodeWorkspaceResolutionBasis::ExplicitName),
                    attempts,
                    candidates,
                );
            }
            [_, ..] => {
                return resolution(
                    RepositoryMatch::Ambiguous,
                    CodeWorkspaceResolutionReason::AmbiguousExplicitName,
                    Some(CodeWorkspaceResolutionBasis::ExplicitName),
                    attempts,
                    candidates,
                );
            }
            [] => {}
        }
    }

    resolution(
        RepositoryMatch::Missing,
        CodeWorkspaceResolutionReason::NoCatalogMatch,
        None,
        attempts,
        Vec::new(),
    )
}

fn label_candidates<'a>(
    candidate: &str,
    catalog: &'a RepositoryCatalog,
) -> Vec<&'a RepositorySummary> {
    let candidate = candidate.to_lowercase();
    catalog
        .repositories
        .iter()
        .filter(|repository| repository.label.to_lowercase() == candidate)
        .collect()
}

fn relative_path_suffix_candidates<'a>(
    candidate: &[&str],
    catalog: &'a RepositoryCatalog,
) -> Vec<&'a RepositorySummary> {
    let mut repository_ids = BTreeSet::new();
    let mut candidates = Vec::new();
    for repository in &catalog.repositories {
        let matches = trusted_path_ends_with_components(&repository.display_path, candidate)
            || repository
                .checkout_aliases
                .iter()
                .any(|alias| trusted_path_ends_with_components(&alias.display_path, candidate));
        if matches && repository_ids.insert(repository.id.as_str()) {
            candidates.push(repository);
        }
    }
    candidates
}

fn path_basename_candidates<'a>(
    candidate: &str,
    catalog: &'a RepositoryCatalog,
) -> Vec<&'a RepositorySummary> {
    let candidate = candidate.to_lowercase();
    catalog
        .repositories
        .iter()
        .filter(|repository| {
            repository.label.to_lowercase() == candidate
                || repository.checkout_leaf.to_lowercase() == candidate
                || repository
                    .checkout_aliases
                    .iter()
                    .any(|alias| alias.checkout_leaf.to_lowercase() == candidate)
        })
        .collect()
}

/// Extract a non-authoritative lexical suffix from an imported relative path.
///
/// Leading `.` and `..` components only describe where the source workspace
/// file used to live, which the browser transport intentionally does not know.
/// They are discarded. Once a normal component appears, later dot components
/// reject suffix matching rather than being collapsed. The remaining
/// components are compared only with catalog-owned paths and are never opened
/// or canonicalized.
fn relative_path_suffix_components(path: &str) -> Option<Vec<&str>> {
    if is_absolute_workspace_path(path)
        || path.starts_with('/')
        || path.starts_with('\\')
        || matches!(path.as_bytes(), [drive, b':', ..] if drive.is_ascii_alphabetic())
    {
        return None;
    }

    let mut saw_normal_component = false;
    let mut components = Vec::new();
    for component in path
        .split(['/', '\\'])
        .filter(|component| !component.is_empty())
    {
        match component {
            "." | ".." if !saw_normal_component => continue,
            "." | ".." => return None,
            _ => {
                saw_normal_component = true;
                components.push(component);
            }
        }
    }
    (components.len() >= 2).then_some(components)
}

fn trusted_path_ends_with_components(path: &str, candidate: &[&str]) -> bool {
    let trusted_components = path
        .split(['/', '\\'])
        .filter(|component| !component.is_empty())
        .collect::<Vec<_>>();
    if trusted_components.len() < candidate.len()
        || trusted_components
            .iter()
            .any(|component| matches!(*component, "." | ".."))
    {
        return false;
    }
    trusted_components[trusted_components.len() - candidate.len()..]
        .iter()
        .zip(candidate)
        .all(|(trusted, imported)| trusted.eq_ignore_ascii_case(imported))
}

fn repository_matches_exact_path(repository: &RepositorySummary, candidate: &str) -> bool {
    repository.display_path == candidate
        || repository
            .checkout_aliases
            .iter()
            .any(|alias| alias.display_path == candidate)
}

fn resolution<'a>(
    outcome: RepositoryMatch<'a>,
    reason: CodeWorkspaceResolutionReason,
    resolution_basis: Option<CodeWorkspaceResolutionBasis>,
    attempts: Vec<CodeWorkspaceMatchAttempt>,
    all_candidates: Vec<&RepositorySummary>,
) -> RepositoryResolution<'a> {
    let candidates = all_candidates
        .iter()
        .take(MAX_CODE_WORKSPACE_DIAGNOSTIC_CANDIDATES)
        .map(|repository| repository_candidate(repository))
        .collect();
    RepositoryResolution {
        outcome,
        reason,
        resolution_basis,
        attempts,
        candidates,
        candidates_truncated: all_candidates.len() > MAX_CODE_WORKSPACE_DIAGNOSTIC_CANDIDATES,
    }
}

fn match_attempt(
    basis: CodeWorkspaceResolutionBasis,
    value: &str,
    candidate_count: usize,
) -> CodeWorkspaceMatchAttempt {
    CodeWorkspaceMatchAttempt {
        basis,
        value: value.to_owned(),
        candidate_count: bounded_count(candidate_count),
    }
}

fn repository_candidate(repository: &RepositorySummary) -> CodeWorkspaceMatchCandidate {
    CodeWorkspaceMatchCandidate {
        label: repository.label.clone(),
        display_path: repository.display_path.clone(),
    }
}

fn bounded_count(count: usize) -> u32 {
    u32::try_from(count).unwrap_or(u32::MAX)
}

fn is_absolute_workspace_path(path: &str) -> bool {
    path.starts_with('/')
        || path.starts_with("\\\\")
        || path.starts_with("//")
        || matches!(
            path.as_bytes(),
            [drive, b':', separator, ..]
                if drive.is_ascii_alphabetic() && matches!(separator, b'/' | b'\\')
        )
}

fn workspace_basename(path: &str) -> Option<&str> {
    let path = path.trim_end_matches(['/', '\\']);
    let basename = path.rsplit(['/', '\\']).next()?;
    (!basename.is_empty() && basename != "." && basename != "..").then_some(basename)
}

fn bounded_folder_name(name: &str) -> String {
    truncate_chars(name, MAX_CODE_WORKSPACE_FOLDER_NAME_CHARS)
}

fn unmatched_folder(
    name: String,
    raw_path: String,
    status: CodeWorkspaceFolderStatus,
    message: String,
) -> CodeWorkspaceFolderImport {
    CodeWorkspaceFolderImport {
        name,
        raw_path,
        status,
        repository_id: None,
        repository_label: None,
        repository_display_path: None,
        base_ref: None,
        message: Some(message),
    }
}

fn folder_warning(
    code: CodeWorkspaceImportWarningCode,
    folder_name: &str,
    message: &str,
) -> CodeWorkspaceImportWarning {
    CodeWorkspaceImportWarning {
        code,
        message: message.to_owned(),
        folder_name: Some(folder_name.to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{RepositoryBranchSummary, model::RepositoryCheckoutAlias};
    use sha2::{Digest, Sha256};
    use uuid::Uuid;

    fn repository_id(seed: &str) -> String {
        format!("repo_{}", hex::encode(Sha256::digest(seed.as_bytes())))
    }

    fn repository(id: &str, label: &str, display_path: &str, branch: &str) -> RepositorySummary {
        RepositorySummary {
            id: repository_id(id),
            label: label.to_owned(),
            checkout_leaf: workspace_basename(display_path).unwrap_or(label).to_owned(),
            display_path: display_path.to_owned(),
            checkout_aliases: Vec::new(),
            origin_url: None,
            default_branch: RepositoryBranchSummary {
                name: branch.to_owned(),
                full_ref: format!("refs/heads/{branch}"),
                commit_oid: "0123456789abcdef".to_owned(),
            },
            available_branches: Vec::new(),
        }
    }

    fn catalog(repositories: Vec<RepositorySummary>) -> RepositoryCatalog {
        RepositoryCatalog {
            repository_root_display_path: "/repos".to_owned(),
            repositories,
            skipped_entries: 0,
        }
    }

    fn request(file_name: &str, contents: impl Into<String>) -> CodeWorkspaceImportRequest {
        CodeWorkspaceImportRequest {
            file_name: file_name.to_owned(),
            contents: contents.into(),
            import_id: None,
        }
    }

    #[test]
    fn imports_jsonc_and_matches_only_catalog_repositories() {
        let result = import_code_workspace(
            request(
                "Payments.CODE-WORKSPACE",
                "\u{feff}{
                    // Existing VS Code configuration is preview-only.
                    folders: [
                        { name: 'Renamed folder', path: '/repos/catalog-name' },
                        '../checkout-api',
                        { name: 'payments', path: '.' },
                    ],
                    settings: { 'editor.formatOnSave': true },
                }",
            ),
            &catalog(vec![
                repository("one", "catalog-name", "/repos/catalog-name", "main"),
                repository("two", "checkout-api", "/repos/checkout-api", "develop"),
                repository("three", "payments", "/repos/payments", "trunk"),
            ]),
        )
        .expect("valid workspace import");

        assert_eq!(result.file_name, "Payments.CODE-WORKSPACE");
        assert_eq!(result.suggested_title, "Payments");
        assert_eq!(result.suggested_repository_set_label, "VS Code · Payments");
        assert_eq!(
            result
                .folders
                .iter()
                .map(|folder| folder.status)
                .collect::<Vec<_>>(),
            vec![
                CodeWorkspaceFolderStatus::Matched,
                CodeWorkspaceFolderStatus::Matched,
                CodeWorkspaceFolderStatus::Matched,
            ]
        );
        assert_eq!(
            result.repositories,
            vec![
                WorkspaceRepositoryRequest {
                    repository_id: Some(repository_id("one")),
                    label: "catalog-name".to_owned(),
                    base_ref: "main".to_owned(),
                },
                WorkspaceRepositoryRequest {
                    repository_id: Some(repository_id("two")),
                    label: "checkout-api".to_owned(),
                    base_ref: "develop".to_owned(),
                },
                WorkspaceRepositoryRequest {
                    repository_id: Some(repository_id("three")),
                    label: "payments".to_owned(),
                    base_ref: "trunk".to_owned(),
                },
            ]
        );
        assert_eq!(
            result.warnings[0].code,
            CodeWorkspaceImportWarningCode::ConfigurationIgnored
        );
        assert_ne!(result.import_id, Uuid::nil());
    }

    #[cfg(debug_assertions)]
    #[test]
    fn development_diagnostics_explain_the_catalog_and_zero_candidate_attempts() {
        let mut repositories = (0..20)
            .map(|index| {
                repository(
                    &format!("repo-{index}"),
                    &format!("catalog-{index}"),
                    &format!("/repos/catalog-{index}"),
                    "main",
                )
            })
            .collect::<Vec<_>>();
        repositories.sort_by(|left, right| left.label.cmp(&right.label));
        let mut local_catalog = catalog(repositories);
        local_catalog.repository_root_display_path = "/configured/root".to_owned();
        local_catalog.skipped_entries = 3;

        let result = import_code_workspace(
            request(
                "infra.code-workspace",
                r#"{ folders: [{ name: "Infrastructure", path: "../infra" }] }"#,
            ),
            &local_catalog,
        )
        .expect("valid workspace");
        let diagnostics = result
            .diagnostics
            .expect("debug builds include import diagnostics");

        assert_eq!(
            diagnostics.catalog.repository_root_display_path,
            "/configured/root"
        );
        assert_eq!(diagnostics.catalog.repository_count, 20);
        assert_eq!(diagnostics.catalog.skipped_entries, 3);
        assert_eq!(diagnostics.catalog.repositories.len(), 16);
        assert!(diagnostics.catalog.repositories_truncated);

        let folder = &diagnostics.folders[0];
        assert_eq!(folder.folder_index, 0);
        assert_eq!(folder.status, CodeWorkspaceFolderStatus::Missing);
        assert_eq!(folder.reason, CodeWorkspaceResolutionReason::NoCatalogMatch);
        assert_eq!(folder.resolution_basis, None);
        assert_eq!(
            folder
                .attempts
                .iter()
                .map(|attempt| (
                    attempt.basis,
                    attempt.value.as_str(),
                    attempt.candidate_count
                ))
                .collect::<Vec<_>>(),
            vec![
                (CodeWorkspaceResolutionBasis::PathBasename, "infra", 0),
                (
                    CodeWorkspaceResolutionBasis::ExplicitName,
                    "Infrastructure",
                    0
                ),
            ]
        );
        assert!(folder.candidates.is_empty());
        assert!(!folder.candidates_truncated);
    }

    #[cfg(debug_assertions)]
    #[test]
    fn development_diagnostic_candidate_lists_are_bounded() {
        let repositories = (0..20)
            .map(|index| {
                repository(
                    &format!("repo-{index}"),
                    "shared",
                    &format!("/repos/shared-{index}"),
                    "main",
                )
            })
            .collect();
        let result = import_code_workspace(
            request(
                "ambiguous.code-workspace",
                r#"{ folders: [{ path: "../shared" }] }"#,
            ),
            &catalog(repositories),
        )
        .expect("valid workspace");
        let diagnostics = result
            .diagnostics
            .expect("debug builds include import diagnostics");
        let folder = &diagnostics.folders[0];

        assert_eq!(
            folder.reason,
            CodeWorkspaceResolutionReason::AmbiguousPathBasename
        );
        assert_eq!(folder.attempts[0].candidate_count, 20);
        assert_eq!(folder.candidates.len(), 8);
        assert!(folder.candidates_truncated);
        assert_eq!(diagnostics.catalog.repositories.len(), 16);
        assert!(diagnostics.catalog.repositories_truncated);
    }

    #[test]
    fn transport_cannot_supply_the_server_owned_import_id() {
        let request: CodeWorkspaceImportRequest = serde_json::from_value(serde_json::json!({
            "fileName": "safe.code-workspace",
            "contents": "{ folders: [] }"
        }))
        .expect("deserialize wire request");
        assert_eq!(request.import_id(), None);

        let spoofed = serde_json::from_value::<CodeWorkspaceImportRequest>(serde_json::json!({
            "fileName": "safe.code-workspace",
            "contents": "{ folders: [] }",
            "importId": "11111111-1111-4111-8111-111111111111"
        }));
        assert!(spoofed.is_err());
    }

    #[test]
    fn assigned_import_id_is_preserved_in_the_result() {
        let import_id = Uuid::from_u128(1);
        let mut request = request("safe.code-workspace", "{ folders: [] }");
        request.assign_import_id(import_id);
        let result = import_code_workspace(request, &catalog(Vec::new())).expect("valid workspace");

        assert_eq!(result.import_id, import_id);
    }

    #[test]
    fn uri_folders_are_redacted_before_results_or_diagnostics_are_serialized() {
        let sensitive_uri = "vscode-remote://user:secret@host/repo?token=sentinel";
        let sensitive_uri_without_slashes =
            "vscode-remote:user:secret@host/repo?token=sentinel-two";
        let result = import_code_workspace(
            request(
                "private.code-workspace",
                format!(
                    r#"{{
                        folders: [
                            {{ name: "{sensitive_uri}", uri: "{sensitive_uri}" }},
                            {{ path: "{sensitive_uri}" }},
                            "{sensitive_uri}",
                            {{ name: 42, uri: "{sensitive_uri}" }},
                            "{sensitive_uri_without_slashes}",
                            {{ name: "{sensitive_uri}", path: "../infra" }},
                            {{ name: "{sensitive_uri_without_slashes}" }},
                            {{ name: "{sensitive_uri}", path: 42 }},
                            "C:\\repos\\checkout-api",
                        ],
                    }}"#
                ),
            ),
            &catalog(vec![
                repository("infra", "infra", "/repos/infra", "main"),
                repository("checkout", "checkout-api", "/repos/checkout-api", "main"),
            ]),
        )
        .expect("URI entries are unsupported rather than invalid");

        for folder in &result.folders[..5] {
            assert_eq!(folder.status, CodeWorkspaceFolderStatus::Unsupported);
            assert_eq!(folder.raw_path, UNSUPPORTED_URI_PLACEHOLDER);
        }
        assert_eq!(
            result
                .folders
                .iter()
                .map(|folder| folder.status)
                .collect::<Vec<_>>(),
            vec![
                CodeWorkspaceFolderStatus::Unsupported,
                CodeWorkspaceFolderStatus::Unsupported,
                CodeWorkspaceFolderStatus::Unsupported,
                CodeWorkspaceFolderStatus::Unsupported,
                CodeWorkspaceFolderStatus::Unsupported,
                CodeWorkspaceFolderStatus::Matched,
                CodeWorkspaceFolderStatus::Unsupported,
                CodeWorkspaceFolderStatus::Unsupported,
                CodeWorkspaceFolderStatus::Matched,
            ]
        );
        assert!(
            result
                .folders
                .iter()
                .all(|folder| !folder.name.contains("sentinel"))
        );
        assert_eq!(result.folders[5].name, "infra");
        assert_eq!(result.folders[5].raw_path, "../infra");
        assert_eq!(result.folders[5].repository_label.as_deref(), Some("infra"));
        assert_eq!(result.folders[6].name, "Folder 7");
        assert_eq!(result.folders[7].name, "Folder 8");

        #[cfg(debug_assertions)]
        for diagnostic in result
            .diagnostics
            .as_ref()
            .expect("debug diagnostics")
            .folders
            .iter()
            .filter(|diagnostic| diagnostic.status == CodeWorkspaceFolderStatus::Unsupported)
        {
            assert_eq!(diagnostic.status, CodeWorkspaceFolderStatus::Unsupported);
            assert!(diagnostic.attempts.is_empty());
            assert!(diagnostic.candidates.is_empty());
        }
        #[cfg(debug_assertions)]
        {
            let safe_path_diagnostic = &result
                .diagnostics
                .as_ref()
                .expect("debug diagnostics")
                .folders[5];
            assert_eq!(
                safe_path_diagnostic.reason,
                CodeWorkspaceResolutionReason::MatchedPathBasename
            );
            assert_eq!(safe_path_diagnostic.attempts.len(), 1);
            assert_eq!(safe_path_diagnostic.attempts[0].value, "infra");
            assert!(
                result
                    .diagnostics
                    .as_ref()
                    .expect("debug diagnostics")
                    .folders
                    .iter()
                    .flat_map(|diagnostic| diagnostic.attempts.iter())
                    .all(|attempt| !attempt.value.contains("sentinel"))
            );
        }

        let serialized = serde_json::to_string(&result).expect("serialize import result");
        for sensitive_fragment in [
            sensitive_uri,
            sensitive_uri_without_slashes,
            "user:secret",
            "token=sentinel",
            "vscode-remote://",
            "vscode-remote:user",
        ] {
            assert!(
                !serialized.contains(sensitive_fragment),
                "serialized result leaked {sensitive_fragment}"
            );
        }
        assert_eq!(serialized.matches(UNSUPPORTED_URI_PLACEHOLDER).count(), 5);
    }

    #[test]
    fn reports_ambiguous_missing_unsupported_and_duplicate_folders() {
        let result = import_code_workspace(
            request(
                "mixed.code-workspace",
                r#"{
                    folders: [
                        { path: "../shared" },
                        { path: "../absent" },
                        { name: "Remote", uri: "vscode-remote://ssh-remote+host/repo" },
                        { path: "C:\\repos\\checkout-api" },
                        { name: "Again", path: "/repos/checkout-api" },
                    ],
                }"#,
            ),
            &catalog(vec![
                repository("one", "shared", "/repos/shared-one", "main"),
                repository("two", "SHARED", "/repos/shared-two", "main"),
                repository("three", "checkout-api", "/repos/checkout-api", "main"),
            ]),
        )
        .expect("partially matchable workspace");

        assert_eq!(
            result
                .folders
                .iter()
                .map(|folder| folder.status)
                .collect::<Vec<_>>(),
            vec![
                CodeWorkspaceFolderStatus::Ambiguous,
                CodeWorkspaceFolderStatus::Missing,
                CodeWorkspaceFolderStatus::Unsupported,
                CodeWorkspaceFolderStatus::Matched,
                CodeWorkspaceFolderStatus::Matched,
            ]
        );
        assert_eq!(result.folders[2].raw_path, UNSUPPORTED_URI_PLACEHOLDER);
        assert_eq!(
            result.repositories,
            vec![WorkspaceRepositoryRequest {
                repository_id: Some(repository_id("three")),
                label: "checkout-api".to_owned(),
                base_ref: "main".to_owned(),
            }]
        );
        assert_eq!(
            result
                .warnings
                .iter()
                .map(|warning| warning.code)
                .collect::<Vec<_>>(),
            vec![
                CodeWorkspaceImportWarningCode::FolderAmbiguous,
                CodeWorkspaceImportWarningCode::FolderMissing,
                CodeWorkspaceImportWarningCode::FolderUnsupported,
                CodeWorkspaceImportWarningCode::DuplicateRepository,
            ]
        );
    }

    #[test]
    fn exact_absolute_path_wins_over_a_mismatched_folder_name() {
        let result = import_code_workspace(
            request(
                "exact.code-workspace",
                r#"{ folders: [{ name: "other", path: "/repos/exact" }] }"#,
            ),
            &catalog(vec![
                repository("one", "catalog-label", "/repos/exact", "main"),
                repository("two", "other", "/repos/other", "develop"),
            ]),
        )
        .expect("valid workspace");

        assert_eq!(
            result.folders[0].repository_label.as_deref(),
            Some("catalog-label")
        );
        assert_eq!(result.repositories[0].label, "catalog-label");
    }

    #[test]
    fn unique_checkout_leaf_matches_a_different_unique_origin_label() {
        let result = import_code_workspace(
            request(
                "bmc.code-workspace",
                r#"{ folders: [{ path: "../ppec-ui" }] }"#,
            ),
            &catalog(vec![repository(
                "one",
                "ppec-ui-main",
                "/repos/ppec-ui",
                "main",
            )]),
        )
        .expect("valid workspace");

        assert_eq!(result.folders[0].status, CodeWorkspaceFolderStatus::Matched);
        assert_eq!(
            result.folders[0].repository_label.as_deref(),
            Some("ppec-ui-main")
        );
        assert_eq!(result.repositories[0].label, "ppec-ui-main");
        #[cfg(debug_assertions)]
        assert_eq!(
            result.diagnostics.expect("debug diagnostics").folders[0].reason,
            CodeWorkspaceResolutionReason::MatchedPathBasename
        );
    }

    #[test]
    fn relative_path_suffix_resolves_the_real_bmc_shape_before_ambiguous_basenames() {
        let local_catalog = catalog(vec![
            repository(
                "ppec",
                "ppec-ui-main",
                "/repos/bmc-virtual-console/ppec-ui",
                "master",
            ),
            repository(
                "ppec-decoy",
                "ppec-ui-archive",
                "/repos/archive/ppec-ui",
                "main",
            ),
            repository(
                "api",
                "bmc-api",
                "/repos/bmc-virtual-console/bmc-api",
                "develop",
            ),
            repository(
                "api-decoy",
                "bmc-api-archive",
                "/repos/archive/bmc-api",
                "main",
            ),
            repository(
                "sdk",
                "bmc-api-sdk-go",
                "/repos/bmc-virtual-console/bmc-api-sdk-go",
                "main",
            ),
            repository(
                "sdk-decoy",
                "bmc-api-sdk-go-archive",
                "/repos/archive/bmc-api-sdk-go",
                "main",
            ),
        ]);
        assert_eq!(path_basename_candidates("ppec-ui", &local_catalog).len(), 2);
        assert_eq!(path_basename_candidates("bmc-api", &local_catalog).len(), 2);
        assert_eq!(
            path_basename_candidates("bmc-api-sdk-go", &local_catalog).len(),
            2
        );

        let result = import_code_workspace(
            request(
                "bmc.code-workspace",
                r#"{
                    folders: [
                        { path: "bmc-virtual-console/ppec-ui" },
                        { path: "bmc-virtual-console/bmc-api" },
                        { path: "bmc-virtual-console/bmc-api-sdk-go" },
                    ],
                }"#,
            ),
            &local_catalog,
        )
        .expect("BMC workspace import");

        assert_eq!(
            result
                .repositories
                .iter()
                .map(|repository| repository.label.as_str())
                .collect::<Vec<_>>(),
            vec!["ppec-ui-main", "bmc-api", "bmc-api-sdk-go"]
        );
        assert_eq!(
            serde_json::to_value(CodeWorkspaceResolutionBasis::RelativePathSuffix)
                .expect("serialize resolution basis"),
            serde_json::json!("relativePathSuffix")
        );
        assert_eq!(
            serde_json::to_value(CodeWorkspaceResolutionReason::MatchedRelativePathSuffix)
                .expect("serialize matched reason"),
            serde_json::json!("matchedRelativePathSuffix")
        );
        assert_eq!(
            serde_json::to_value(CodeWorkspaceResolutionReason::AmbiguousRelativePathSuffix)
                .expect("serialize ambiguous reason"),
            serde_json::json!("ambiguousRelativePathSuffix")
        );
        #[cfg(debug_assertions)]
        {
            let diagnostics = result.diagnostics.expect("development diagnostics");
            assert!(diagnostics.folders.iter().all(|folder| {
                folder.reason == CodeWorkspaceResolutionReason::MatchedRelativePathSuffix
                    && folder.resolution_basis
                        == Some(CodeWorkspaceResolutionBasis::RelativePathSuffix)
                    && folder.attempts.len() == 1
                    && folder.attempts[0].basis == CodeWorkspaceResolutionBasis::RelativePathSuffix
                    && folder.attempts[0].candidate_count == 1
            }));
            assert_eq!(
                diagnostics.folders[0].attempts[0].value,
                "bmc-virtual-console/ppec-ui"
            );
        }
    }

    #[test]
    fn relative_path_suffix_normalizes_windows_and_unix_separators() {
        let local_catalog = catalog(vec![
            repository("target", "service", r"C:\src\active\service", "main"),
            repository(
                "decoy",
                "service-archive",
                r"D:\src\archive\service",
                "main",
            ),
        ]);

        for raw_path in [r"active\service", "active/service"] {
            let resolution = match_repository(raw_path, None, &local_catalog);
            assert_eq!(
                resolution.reason,
                CodeWorkspaceResolutionReason::MatchedRelativePathSuffix
            );
            assert_eq!(
                resolution.resolution_basis,
                Some(CodeWorkspaceResolutionBasis::RelativePathSuffix)
            );
            assert_eq!(resolution.attempts[0].value, "active/service");
            match resolution.outcome {
                RepositoryMatch::Matched(repository) => {
                    assert_eq!(repository.id, repository_id("target"));
                }
                RepositoryMatch::Missing | RepositoryMatch::Ambiguous => {
                    panic!("Windows separator suffix should match uniquely")
                }
            }
        }
    }

    #[test]
    fn relative_path_suffix_uses_checkout_aliases_and_deduplicates_repository_ids() {
        let mut primary = repository("primary", "bmc-api", "/repos/bmc-api", "develop");
        primary.checkout_aliases.extend([
            RepositoryCheckoutAlias {
                checkout_leaf: "bmc-remote-view".to_owned(),
                display_path: "/repos/bmc-virtual-console/bmc-remote-view".to_owned(),
            },
            RepositoryCheckoutAlias {
                checkout_leaf: "bmc-remote-view-copy".to_owned(),
                display_path: "/mirror/bmc-virtual-console/bmc-remote-view".to_owned(),
            },
        ]);
        let local_catalog = catalog(vec![
            primary,
            repository(
                "decoy",
                "bmc-remote-view-archive",
                "/repos/archive/bmc-remote-view",
                "main",
            ),
        ]);

        let resolution =
            match_repository("bmc-virtual-console/bmc-remote-view", None, &local_catalog);

        assert_eq!(
            resolution.reason,
            CodeWorkspaceResolutionReason::MatchedRelativePathSuffix
        );
        assert_eq!(resolution.attempts[0].candidate_count, 1);
        match resolution.outcome {
            RepositoryMatch::Matched(repository) => {
                assert_eq!(repository.id, repository_id("primary"));
            }
            RepositoryMatch::Missing | RepositoryMatch::Ambiguous => {
                panic!("trusted checkout alias should match its repository once")
            }
        }
    }

    #[test]
    fn dot_components_after_a_normal_component_and_short_suffixes_fall_back_to_basename() {
        let local_catalog = catalog(vec![repository(
            "target",
            "service-origin",
            "/repos/active/service",
            "main",
        )]);

        for raw_path in [
            "../service",
            "active/../service",
            "active/./service",
            "service",
            r"\active\service",
            r"C:active\service",
        ] {
            let resolution = match_repository(raw_path, None, &local_catalog);
            assert_eq!(
                resolution.reason,
                CodeWorkspaceResolutionReason::MatchedPathBasename,
                "unexpected resolution for {raw_path}"
            );
            assert_eq!(
                resolution.attempts[0].basis,
                CodeWorkspaceResolutionBasis::PathBasename
            );
        }
    }

    #[test]
    fn leading_parent_components_enable_infra_suffixes_without_granting_path_authority() {
        let local_catalog = catalog(vec![
            repository(
                "asset",
                "asset-status",
                "/repos/active/infra/asset-status",
                "main",
            ),
            repository(
                "asset-decoy",
                "asset-status-archive",
                "/repos/archive/asset-status",
                "main",
            ),
            repository(
                "cluster",
                "cluster-status",
                "/repos/active/infra/cluster-status",
                "main",
            ),
            repository(
                "cluster-decoy",
                "cluster-status-archive",
                "/repos/archive/cluster-status",
                "main",
            ),
            repository(
                "network",
                "network-status",
                "/repos/active/infra/network-status",
                "main",
            ),
            repository(
                "network-decoy",
                "network-status-archive",
                "/repos/archive/network-status",
                "main",
            ),
        ]);
        let result = import_code_workspace(
            request(
                "infra.code-workspace",
                r#"{
                    folders: [
                        { path: "../active/infra/asset-status" },
                        { path: "../active/infra/cluster-status" },
                        { path: "../active/infra/network-status" },
                    ],
                }"#,
            ),
            &local_catalog,
        )
        .expect("infra workspace import");

        assert_eq!(
            result
                .repositories
                .iter()
                .map(|repository| repository.label.as_str())
                .collect::<Vec<_>>(),
            vec!["asset-status", "cluster-status", "network-status"]
        );
        #[cfg(debug_assertions)]
        assert_eq!(
            result
                .diagnostics
                .expect("development diagnostics")
                .folders
                .iter()
                .map(|folder| (
                    folder.reason,
                    folder.attempts[0].value.as_str(),
                    folder.attempts[0].candidate_count,
                ))
                .collect::<Vec<_>>(),
            vec![
                (
                    CodeWorkspaceResolutionReason::MatchedRelativePathSuffix,
                    "active/infra/asset-status",
                    1,
                ),
                (
                    CodeWorkspaceResolutionReason::MatchedRelativePathSuffix,
                    "active/infra/cluster-status",
                    1,
                ),
                (
                    CodeWorkspaceResolutionReason::MatchedRelativePathSuffix,
                    "active/infra/network-status",
                    1,
                ),
            ]
        );
    }

    #[cfg(debug_assertions)]
    #[test]
    fn ambiguous_relative_suffix_diagnostics_are_bounded() {
        let repositories = (0..20)
            .map(|index| {
                repository(
                    &format!("repo-{index}"),
                    &format!("shared-{index}"),
                    &format!("/repos/{index}/team/shared"),
                    "main",
                )
            })
            .collect();
        let result = import_code_workspace(
            request(
                "ambiguous-relative.code-workspace",
                r#"{ folders: [{ path: "team/shared" }] }"#,
            ),
            &catalog(repositories),
        )
        .expect("ambiguous relative workspace");
        let folder = &result.diagnostics.expect("development diagnostics").folders[0];

        assert_eq!(
            folder.reason,
            CodeWorkspaceResolutionReason::AmbiguousRelativePathSuffix
        );
        assert_eq!(
            folder.resolution_basis,
            Some(CodeWorkspaceResolutionBasis::RelativePathSuffix)
        );
        assert_eq!(folder.attempts.len(), 1);
        assert_eq!(folder.attempts[0].candidate_count, 20);
        assert_eq!(folder.candidates.len(), 8);
        assert!(folder.candidates_truncated);
    }

    #[test]
    fn unique_checkout_leaf_is_pinned_even_when_catalog_labels_collide() {
        let result = import_code_workspace(
            request(
                "ambiguous-leaf.code-workspace",
                r#"{ folders: [{ path: "../ppec-ui" }] }"#,
            ),
            &catalog(vec![
                repository("one", "shared", "/repos/ppec-ui", "main"),
                repository("two", "SHARED", "/repos/other", "develop"),
            ]),
        )
        .expect("valid workspace");

        assert_eq!(result.folders[0].status, CodeWorkspaceFolderStatus::Matched);
        assert_eq!(result.repositories.len(), 1);
        assert_eq!(
            result.repositories[0].repository_id.as_deref(),
            Some(repository_id("one").as_str())
        );
        #[cfg(debug_assertions)]
        assert_eq!(
            result.diagnostics.expect("debug diagnostics").folders[0].reason,
            CodeWorkspaceResolutionReason::MatchedPathBasename
        );
    }

    #[test]
    fn linked_checkout_aliases_match_once_and_warn_on_duplicate_repository() {
        let mut primary = repository("one", "bmc-api", "/repos/bmc-api", "main");
        primary.checkout_aliases.push(RepositoryCheckoutAlias {
            checkout_leaf: "bmc-remote-view".to_owned(),
            display_path: "/repos/bmc-remote-view".to_owned(),
        });
        let result = import_code_workspace(
            request(
                "linked.code-workspace",
                r#"{
                    folders: [
                        { path: "/repos/bmc-api" },
                        { path: "/repos/bmc-remote-view" },
                    ],
                }"#,
            ),
            &catalog(vec![primary]),
        )
        .expect("valid workspace");

        assert_eq!(
            result
                .folders
                .iter()
                .map(|folder| folder.status)
                .collect::<Vec<_>>(),
            vec![
                CodeWorkspaceFolderStatus::Matched,
                CodeWorkspaceFolderStatus::Matched,
            ]
        );
        assert_eq!(result.repositories.len(), 1);
        assert_eq!(
            result
                .warnings
                .iter()
                .map(|warning| warning.code)
                .collect::<Vec<_>>(),
            vec![CodeWorkspaceImportWarningCode::DuplicateRepository]
        );
        assert_eq!(
            result.folders[1].repository_display_path.as_deref(),
            Some("/repos/bmc-api")
        );
        #[cfg(debug_assertions)]
        assert!(result.diagnostics.expect("debug diagnostics").folders[1].duplicate_repository);
    }

    #[test]
    fn exact_absolute_path_is_pinned_when_its_catalog_label_is_not_unique() {
        let result = import_code_workspace(
            request(
                "ambiguous-exact.code-workspace",
                r#"{ folders: [{ path: "/repos/first" }] }"#,
            ),
            &catalog(vec![
                repository("one", "shared", "/repos/first", "main"),
                repository("two", "SHARED", "/repos/second", "develop"),
            ]),
        )
        .expect("valid workspace");

        assert_eq!(result.folders[0].status, CodeWorkspaceFolderStatus::Matched);
        assert_eq!(
            result.folders[0].repository_label.as_deref(),
            Some("shared")
        );
        assert_eq!(
            result.repositories[0].repository_id.as_deref(),
            Some(repository_id("one").as_str())
        );
        assert!(result.warnings.is_empty());
    }

    #[test]
    fn multiple_exact_paths_emit_distinct_pinned_ids_despite_duplicate_labels() {
        let result = import_code_workspace(
            request(
                "duplicate-exact.code-workspace",
                r#"{
                    folders: [
                        { path: "/repos/first" },
                        { path: "/repos/second" },
                    ],
                }"#,
            ),
            &catalog(vec![
                repository("one", "shared", "/repos/first", "main"),
                repository("two", "SHARED", "/repos/second", "develop"),
            ]),
        )
        .expect("valid workspace");

        assert_eq!(
            result
                .folders
                .iter()
                .map(|folder| folder.status)
                .collect::<Vec<_>>(),
            vec![
                CodeWorkspaceFolderStatus::Matched,
                CodeWorkspaceFolderStatus::Matched,
            ]
        );
        assert_eq!(
            result
                .repositories
                .iter()
                .map(|repository| repository.repository_id.as_deref())
                .collect::<Vec<_>>(),
            vec![
                Some(repository_id("one").as_str()),
                Some(repository_id("two").as_str()),
            ]
        );
        assert!(result.warnings.is_empty());
        assert!(
            wts_core::workspace::CreateWorkspaceRequest {
                intent: wts_core::workspace::WorkspaceIntent::RepositorySet {
                    label: "duplicate-exact".to_owned(),
                },
                title: "Duplicate exact".to_owned(),
                preferred_provider: wts_core::workspace::WorkspaceProvider::VsCode,
                repositories: result.repositories,
                runtime: None,
                planning: None,
            }
            .normalize()
            .is_ok()
        );
    }

    #[test]
    fn rejects_invalid_or_oversized_imports() {
        let empty_catalog = catalog(Vec::new());
        assert_eq!(
            import_code_workspace(
                request("../unsafe.code-workspace", "{ folders: [] }"),
                &empty_catalog,
            ),
            Err(CodeWorkspaceImportError::Invalid)
        );
        assert_eq!(
            import_code_workspace(request("unsafe.txt", "{ folders: [] }"), &empty_catalog,),
            Err(CodeWorkspaceImportError::Invalid)
        );
        assert_eq!(
            import_code_workspace(
                request("broken.code-workspace", "{ folders: ["),
                &empty_catalog,
            ),
            Err(CodeWorkspaceImportError::Invalid)
        );
        assert_eq!(
            import_code_workspace(
                request(
                    "large.code-workspace",
                    "x".repeat(MAX_CODE_WORKSPACE_CONTENT_BYTES + 1),
                ),
                &empty_catalog,
            ),
            Err(CodeWorkspaceImportError::TooLarge)
        );

        let too_many = serde_json::json!({ "folders": vec!["repo"; 33] }).to_string();
        assert_eq!(
            import_code_workspace(request("many.code-workspace", too_many), &empty_catalog,),
            Err(CodeWorkspaceImportError::Invalid)
        );

        let long_path =
            serde_json::json!({ "folders": ["x".repeat(MAX_CODE_WORKSPACE_PATH_BYTES + 1)] })
                .to_string();
        assert_eq!(
            import_code_workspace(request("long.code-workspace", long_path), &empty_catalog,),
            Err(CodeWorkspaceImportError::Invalid)
        );
    }

    #[test]
    fn result_does_not_copy_ignored_configuration_or_source_contents() {
        let secret = "do-not-copy-this-setting";
        let result = import_code_workspace(
            request(
                "safe.code-workspace",
                format!(r#"{{ folders: [], settings: {{ "example.secret": "{secret}" }} }}"#),
            ),
            &catalog(Vec::new()),
        )
        .expect("valid workspace");
        let serialized = serde_json::to_string(&result).expect("serialize import result");

        assert!(!serialized.contains(secret));
        assert!(!serialized.contains("settings"));
        assert!(serialized.contains("configurationIgnored"));
    }
}
