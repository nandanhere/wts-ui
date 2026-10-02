use crate::{AgentProvider, RepositoryForge, TerminalProvider};
#[cfg(target_os = "macos")]
use sha2::{Digest, Sha256};
#[cfg(target_os = "macos")]
use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::PathBuf,
};
use std::{
    path::Path,
    process::{Command, Stdio},
};
use url::Url;
#[cfg(target_os = "macos")]
use uuid::Uuid;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LaunchFailure {
    Unavailable,
    Rejected,
}

/// A forge deep link constructed only from re-inspected local Git metadata.
///
/// Fields are private so browser/WebView input cannot manufacture an
/// arbitrary URL and pass it to [`ExternalLauncher`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RepositoryBaseTarget {
    forge: RepositoryForge,
    host: String,
    repository_path: String,
    commit_oid: String,
    web_url: String,
}

/// A forge create-form target constructed only from re-inspected Git facts and
/// bounded, reviewed draft fields.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChangeRequestDraftTarget {
    forge: RepositoryForge,
    host: String,
    repository_path: String,
    source_branch: String,
    target_branch: String,
    head_commit_oid: String,
    web_url: String,
}

/// A GitHub review URL built from a re-inspected catalog origin and a PR number.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GithubReviewTarget {
    repository_path: String,
    number: u64,
    web_url: String,
}

/// A GitLab merge request URL built from a re-inspected worktree origin and an IID.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GitlabMergeRequestTarget {
    host: String,
    repository_path: String,
    iid: u64,
    web_url: String,
}

impl GitlabMergeRequestTarget {
    pub(crate) fn from_origin(origin: &str, iid: u64) -> Option<Self> {
        if iid == 0 || iid > i64::MAX as u64 {
            return None;
        }
        if !gitlab_merge_request_origin_has_safe_authority(origin) {
            return None;
        }
        let (host, raw_path) = repository_origin_parts(origin)?;
        let host = normalized_forge_host(host)?;
        if forge_for_host(&host)? != RepositoryForge::Gitlab {
            return None;
        }
        let repository_path = normalized_repository_path(raw_path, RepositoryForge::Gitlab)?;
        let web_url = format!("https://{host}/{repository_path}/-/merge_requests/{iid}");
        Some(Self {
            host,
            repository_path,
            iid,
            web_url,
        })
    }

    pub fn host(&self) -> &str {
        &self.host
    }

    pub fn repository_path(&self) -> &str {
        &self.repository_path
    }

    pub fn iid(&self) -> u64 {
        self.iid
    }

    pub fn web_url(&self) -> &str {
        &self.web_url
    }
}

fn gitlab_merge_request_origin_has_safe_authority(origin: &str) -> bool {
    if let Some((scheme, remainder)) = origin.split_once("://") {
        let Some(authority) = remainder.split('/').next() else {
            return false;
        };
        return match scheme.to_ascii_lowercase().as_str() {
            "https" => !authority.contains('@') && !authority.contains(':'),
            "ssh" => {
                let host = authority.strip_prefix("git@").unwrap_or(authority);
                !host.contains('@') && !host.contains(':')
            }
            _ => false,
        };
    }

    let Some((authority, _)) = origin.split_once(':') else {
        return false;
    };
    !authority.contains('@') || authority.starts_with("git@") && !authority[4..].contains('@')
}

impl GithubReviewTarget {
    pub(crate) fn from_origin(origin: &str, number: u64) -> Option<Self> {
        if number == 0 || number > i64::MAX as u64 {
            return None;
        }
        let (host, raw_path) = repository_origin_parts(origin)?;
        let host = normalized_forge_host(host)?;
        if host != "github.com" {
            return None;
        }
        let repository_path = normalized_repository_path(raw_path, RepositoryForge::Github)?;
        let web_url = format!("https://github.com/{repository_path}/pull/{number}");
        Some(Self {
            repository_path,
            number,
            web_url,
        })
    }

    pub fn repository_path(&self) -> &str {
        &self.repository_path
    }

    pub fn number(&self) -> u64 {
        self.number
    }

    pub fn web_url(&self) -> &str {
        &self.web_url
    }
}

impl ChangeRequestDraftTarget {
    pub(crate) fn from_remote(
        remote_url: &str,
        source_branch: &str,
        target_branch: &str,
        head_commit_oid: &str,
        title: &str,
        body: &str,
    ) -> Option<Self> {
        if !valid_commit_oid(head_commit_oid)
            || !valid_branch_name(source_branch)
            || !valid_branch_name(target_branch)
            || !valid_draft_text(title, 256)
            || !valid_draft_text(body, 16_000)
        {
            return None;
        }
        let (host, raw_path) = repository_origin_parts(remote_url)?;
        let host = normalized_forge_host(host)?;
        let forge = forge_for_host(&host)?;
        let repository_path = normalized_repository_path(raw_path, forge)?;
        let mut url = Url::parse(&format!("https://{host}/")).ok()?;
        match forge {
            RepositoryForge::Github => {
                url.set_path(&format!(
                    "{repository_path}/compare/{target_branch}...{source_branch}"
                ));
                url.query_pairs_mut()
                    .append_pair("quick_pull", "1")
                    .append_pair("title", title)
                    .append_pair("body", body);
            }
            RepositoryForge::Gitlab => {
                url.set_path(&format!("{repository_path}/-/merge_requests/new"));
                url.query_pairs_mut()
                    .append_pair("merge_request[source_branch]", source_branch)
                    .append_pair("merge_request[target_branch]", target_branch)
                    .append_pair("merge_request[title]", title)
                    .append_pair("merge_request[description]", body);
            }
        }
        let web_url = url.to_string();
        if web_url.len() > 24_000 {
            return None;
        }
        Some(Self {
            forge,
            host,
            repository_path,
            source_branch: source_branch.to_owned(),
            target_branch: target_branch.to_owned(),
            head_commit_oid: head_commit_oid.to_owned(),
            web_url,
        })
    }

    pub fn forge(&self) -> RepositoryForge {
        self.forge
    }
    pub fn host(&self) -> &str {
        &self.host
    }
    pub fn repository_path(&self) -> &str {
        &self.repository_path
    }
    pub fn source_branch(&self) -> &str {
        &self.source_branch
    }
    pub fn target_branch(&self) -> &str {
        &self.target_branch
    }
    pub fn head_commit_oid(&self) -> &str {
        &self.head_commit_oid
    }
    pub fn web_url(&self) -> &str {
        &self.web_url
    }
}

/// A Jira browser target created from trusted imported issue data.
///
/// Fields are private so browser/WebView input cannot pass an arbitrary URL
/// to [`ExternalLauncher`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JiraIssueTarget {
    issue_key: String,
    browser_url: String,
}

impl JiraIssueTarget {
    pub(crate) fn from_browser_url(issue_key: &str, browser_url: &str) -> Option<Self> {
        let issue_key = issue_key.trim().to_ascii_uppercase();
        let url = Url::parse(browser_url).ok()?;
        let host = url.host_str()?;
        let path_segments = url.path_segments()?.collect::<Vec<_>>();
        let issue_path_matches = path_segments.len() >= 2
            && path_segments[path_segments.len() - 2] == "browse"
            && path_segments[path_segments.len() - 1] == issue_key;
        if issue_key.is_empty()
            || url.scheme() != "https"
            || !host.contains('.')
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || !issue_path_matches
        {
            return None;
        }
        Some(Self {
            issue_key,
            browser_url: url.to_string(),
        })
    }

    pub fn issue_key(&self) -> &str {
        &self.issue_key
    }

    pub fn browser_url(&self) -> &str {
        &self.browser_url
    }
}

impl RepositoryBaseTarget {
    pub(crate) fn from_origin(origin: &str, commit_oid: &str) -> Option<Self> {
        if !valid_commit_oid(commit_oid)
            || origin.is_empty()
            || origin.trim() != origin
            || origin.contains(['\0', '\n', '\r', '\t', '\\', '?', '#'])
            || origin.contains("::")
        {
            return None;
        }

        let (host, raw_path) = repository_origin_parts(origin)?;
        let host = normalized_forge_host(host)?;
        let forge = forge_for_host(&host)?;
        let repository_path = normalized_repository_path(raw_path, forge)?;
        let marker = match forge {
            RepositoryForge::Github => "tree",
            RepositoryForge::Gitlab => "-/tree",
        };
        let web_url = format!("https://{host}/{repository_path}/{marker}/{commit_oid}");
        Some(Self {
            forge,
            host,
            repository_path,
            commit_oid: commit_oid.to_owned(),
            web_url,
        })
    }

    pub fn forge(&self) -> RepositoryForge {
        self.forge
    }

    pub fn host(&self) -> &str {
        &self.host
    }

    pub fn repository_path(&self) -> &str {
        &self.repository_path
    }

    pub fn commit_oid(&self) -> &str {
        &self.commit_oid
    }

    pub fn web_url(&self) -> &str {
        &self.web_url
    }
}

pub trait ExternalLauncher: Send + Sync + 'static {
    fn launch_vscode(&self, code_workspace: &Path) -> Result<(), LaunchFailure>;
    fn launch_cli(
        &self,
        workspace: &Path,
        provider: AgentProvider,
        terminal: TerminalProvider,
    ) -> Result<(), LaunchFailure>;
    fn launch_repository_base(&self, target: &RepositoryBaseTarget) -> Result<(), LaunchFailure>;
    fn launch_change_request_draft(
        &self,
        target: &ChangeRequestDraftTarget,
    ) -> Result<(), LaunchFailure>;
    fn launch_github_review(&self, target: &GithubReviewTarget) -> Result<(), LaunchFailure> {
        let _ = target;
        Err(LaunchFailure::Unavailable)
    }
    fn launch_gitlab_merge_request(
        &self,
        target: &GitlabMergeRequestTarget,
    ) -> Result<(), LaunchFailure> {
        let _ = target;
        Err(LaunchFailure::Unavailable)
    }
    fn launch_jira_issue(&self, target: &JiraIssueTarget) -> Result<(), LaunchFailure>;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct ProcessExternalLauncher;

impl ExternalLauncher for ProcessExternalLauncher {
    fn launch_vscode(&self, code_workspace: &Path) -> Result<(), LaunchFailure> {
        let status = vscode_command(code_workspace)
            .status()
            .map_err(map_launch_error)?;
        if status.success() {
            Ok(())
        } else {
            Err(LaunchFailure::Rejected)
        }
    }

    fn launch_cli(
        &self,
        workspace: &Path,
        provider: AgentProvider,
        terminal: TerminalProvider,
    ) -> Result<(), LaunchFailure> {
        #[cfg(target_os = "macos")]
        {
            let report_helper_directory = report_helper_directory()?;
            let hermes_scope = if provider == AgentProvider::Hermes {
                Some(write_hermes_workspace_scope(workspace)?)
            } else {
                None
            };
            let mut command = match terminal {
                TerminalProvider::Terminal => terminal_cli_command(
                    workspace,
                    provider,
                    hermes_scope.as_deref(),
                    &report_helper_directory,
                )?,
                TerminalProvider::Warp => {
                    let config_stem = write_warp_tab_config(
                        workspace,
                        provider,
                        hermes_scope.as_deref(),
                        &report_helper_directory,
                    )?;
                    warp_cli_command(config_stem)
                }
            };
            let status = command.status().map_err(map_launch_error)?;
            if status.success() {
                Ok(())
            } else {
                Err(LaunchFailure::Rejected)
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (workspace, provider, terminal);
            Err(LaunchFailure::Unavailable)
        }
    }

    fn launch_repository_base(&self, target: &RepositoryBaseTarget) -> Result<(), LaunchFailure> {
        #[cfg(target_os = "macos")]
        {
            let status = browser_command(target).status().map_err(map_launch_error)?;
            if status.success() {
                Ok(())
            } else {
                Err(LaunchFailure::Rejected)
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = target;
            Err(LaunchFailure::Unavailable)
        }
    }

    fn launch_change_request_draft(
        &self,
        target: &ChangeRequestDraftTarget,
    ) -> Result<(), LaunchFailure> {
        #[cfg(target_os = "macos")]
        {
            let status = change_request_browser_command(target)
                .status()
                .map_err(map_launch_error)?;
            if status.success() {
                Ok(())
            } else {
                Err(LaunchFailure::Rejected)
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = target;
            Err(LaunchFailure::Unavailable)
        }
    }

    fn launch_github_review(&self, target: &GithubReviewTarget) -> Result<(), LaunchFailure> {
        #[cfg(target_os = "macos")]
        {
            let status = github_review_browser_command(target)
                .status()
                .map_err(map_launch_error)?;
            if status.success() {
                Ok(())
            } else {
                Err(LaunchFailure::Rejected)
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = target;
            Err(LaunchFailure::Unavailable)
        }
    }

    fn launch_gitlab_merge_request(
        &self,
        target: &GitlabMergeRequestTarget,
    ) -> Result<(), LaunchFailure> {
        #[cfg(target_os = "macos")]
        {
            let status = gitlab_merge_request_browser_command(target)
                .status()
                .map_err(map_launch_error)?;
            if status.success() {
                Ok(())
            } else {
                Err(LaunchFailure::Rejected)
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = target;
            Err(LaunchFailure::Unavailable)
        }
    }

    fn launch_jira_issue(&self, target: &JiraIssueTarget) -> Result<(), LaunchFailure> {
        #[cfg(target_os = "macos")]
        {
            let status = jira_browser_command(target)
                .status()
                .map_err(map_launch_error)?;
            if status.success() {
                Ok(())
            } else {
                Err(LaunchFailure::Rejected)
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = target;
            Err(LaunchFailure::Unavailable)
        }
    }
}

fn repository_origin_parts(origin: &str) -> Option<(&str, &str)> {
    if let Some((scheme, remainder)) = origin.split_once("://") {
        if !matches!(scheme.to_ascii_lowercase().as_str(), "https" | "ssh") {
            return None;
        }
        let slash = remainder.find('/')?;
        let (authority, path) = remainder.split_at(slash);
        let authority = authority
            .rsplit_once('@')
            .map(|(_, host)| host)
            .unwrap_or(authority);
        if authority.is_empty() || authority.contains(':') || !path.starts_with('/') {
            return None;
        }
        return Some((authority, &path[1..]));
    }

    let (host, path) = origin.split_once(':')?;
    let host = host.rsplit_once('@').map(|(_, host)| host).unwrap_or(host);
    if host.is_empty() || host.contains('/') || path.is_empty() {
        return None;
    }
    Some((host, path))
}

fn normalized_forge_host(host: &str) -> Option<String> {
    if host.is_empty() || host.len() > 253 || !host.is_ascii() {
        return None;
    }
    let host = host.to_ascii_lowercase();
    let mut labels = host.split('.');
    let first = labels.next()?;
    let remaining = labels.collect::<Vec<_>>();
    if remaining.is_empty()
        || !valid_dns_label(first)
        || remaining.iter().any(|label| !valid_dns_label(label))
    {
        return None;
    }
    Some(host)
}

fn valid_dns_label(label: &str) -> bool {
    !label.is_empty()
        && label.len() <= 63
        && !label.starts_with('-')
        && !label.ends_with('-')
        && label
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

fn forge_for_host(host: &str) -> Option<RepositoryForge> {
    let first = host.split('.').next()?;
    if host == "github.com" || first == "github" {
        Some(RepositoryForge::Github)
    } else if host == "gitlab.com" || first == "gitlab" {
        Some(RepositoryForge::Gitlab)
    } else {
        None
    }
}

fn normalized_repository_path(raw_path: &str, forge: RepositoryForge) -> Option<String> {
    if raw_path.is_empty()
        || raw_path.starts_with('/')
        || raw_path.contains("//")
        || raw_path.contains(['%', ':'])
    {
        return None;
    }
    let raw_path = raw_path.strip_suffix('/').unwrap_or(raw_path);
    let mut segments = raw_path.split('/').collect::<Vec<_>>();
    if segments.len() < 2 || (forge == RepositoryForge::Github && segments.len() != 2) {
        return None;
    }
    let repository = segments.pop()?;
    let repository = repository.strip_suffix(".git").unwrap_or(repository);
    segments.push(repository);
    if segments.iter().any(|segment| {
        segment.is_empty()
            || matches!(*segment, "." | "..")
            || segment.len() > 255
            || !segment.is_ascii()
            || !segment
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    }) {
        return None;
    }
    Some(segments.join("/"))
}

fn valid_commit_oid(value: &str) -> bool {
    (value.len() == 40 || value.len() == 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn valid_branch_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 255
        && value.trim() == value
        && !value.starts_with(['/', '-'])
        && !value.ends_with(['/', '.'])
        && !value.contains("..")
        && !value.contains("@{")
        && !value.contains("//")
        && !value.bytes().any(|byte| {
            byte.is_ascii_control()
                || matches!(byte, b' ' | b'~' | b'^' | b':' | b'?' | b'*' | b'[' | b'\\')
        })
}

fn valid_draft_text(value: &str, limit: usize) -> bool {
    !value.trim().is_empty()
        && value.len() <= limit
        && !value.contains('\0')
        && !value
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
}

fn map_launch_error(error: std::io::Error) -> LaunchFailure {
    match error.kind() {
        std::io::ErrorKind::NotFound | std::io::ErrorKind::PermissionDenied => {
            LaunchFailure::Unavailable
        }
        _ => LaunchFailure::Rejected,
    }
}

#[cfg(target_os = "macos")]
fn vscode_command(code_workspace: &Path) -> Command {
    let mut command = Command::new("/usr/bin/open");
    command
        .arg("-a")
        .arg("Visual Studio Code")
        .arg(code_workspace)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
}

#[cfg(not(target_os = "macos"))]
fn vscode_command(code_workspace: &Path) -> Command {
    let mut command = Command::new("code");
    command
        .arg("--new-window")
        .arg(code_workspace)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
}

#[cfg(target_os = "macos")]
fn terminal_cli_command(
    workspace: &Path,
    provider: AgentProvider,
    hermes_scope: Option<&Path>,
    report_helper_directory: &Path,
) -> Result<Command, LaunchFailure> {
    let mut command = Command::new("osascript");
    command
        .arg("-e")
        .arg(terminal_cli_script(provider))
        // The validated workspace path crosses the AppleScript boundary only
        // as argv. The script applies AppleScript's `quoted form of` before the
        // path reaches Terminal's login shell.
        .arg(workspace)
        .arg(report_helper_directory);
    if provider == AgentProvider::Hermes {
        command.arg(hermes_scope.ok_or(LaunchFailure::Rejected)?);
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    Ok(command)
}

#[cfg(target_os = "macos")]
fn terminal_cli_script(provider: AgentProvider) -> &'static str {
    match provider {
        AgentProvider::Codex => {
            r#"on run argv
set workspacePath to item 1 of argv
set reportHelperDirectory to item 2 of argv
set launchCommand to "cd " & quoted form of workspacePath & " && export WTS_WORKSPACE_DIR=" & quoted form of workspacePath & " && PATH=" & quoted form of reportHelperDirectory & ":$PATH exec codex --sandbox workspace-write --ask-for-approval on-request"
tell application "Terminal"
    activate
    do script launchCommand
end tell
end run"#
        }
        AgentProvider::OpenCode => {
            r#"on run argv
set workspacePath to item 1 of argv
set reportHelperDirectory to item 2 of argv
set launchCommand to "cd " & quoted form of workspacePath & " && export WTS_WORKSPACE_DIR=" & quoted form of workspacePath & " && PATH=" & quoted form of reportHelperDirectory & ":$PATH exec opencode ."
tell application "Terminal"
    activate
    do script launchCommand
end tell
end run"#
        }
        AgentProvider::Hermes => {
            r#"on run argv
set workspacePath to item 1 of argv
set reportHelperDirectory to item 2 of argv
set managedScopePath to item 3 of argv
set launchCommand to "cd " & quoted form of workspacePath & " && export WTS_WORKSPACE_DIR=" & quoted form of workspacePath & " && PATH=" & quoted form of reportHelperDirectory & ":$PATH HERMES_MANAGED_DIR=" & quoted form of managedScopePath & " exec hermes chat --tui"
tell application "Terminal"
    activate
    do script launchCommand
end tell
end run"#
        }
        AgentProvider::Copilot => {
            r#"on run argv
set workspacePath to item 1 of argv
set reportHelperDirectory to item 2 of argv
set launchCommand to "cd " & quoted form of workspacePath & " && export WTS_WORKSPACE_DIR=" & quoted form of workspacePath & " && PATH=" & quoted form of reportHelperDirectory & ":$PATH exec copilot"
tell application "Terminal"
    activate
    do script launchCommand
end tell
end run"#
        }
    }
}

#[cfg(target_os = "macos")]
fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(target_os = "macos")]
fn provider_cli_command(
    workspace: &Path,
    provider: AgentProvider,
    hermes_scope: Option<&Path>,
    report_helper_directory: &Path,
) -> Result<String, LaunchFailure> {
    let workspace_str = workspace.to_str().ok_or(LaunchFailure::Rejected)?;
    let path = report_helper_directory
        .to_str()
        .ok_or(LaunchFailure::Rejected)?;
    let prefix = format!(
        "export WTS_WORKSPACE_DIR={} && PATH={}:\"$PATH\" ",
        shell_single_quote(workspace_str),
        shell_single_quote(path)
    );
    match provider {
        AgentProvider::Codex => Ok(format!(
            "{prefix}exec codex --sandbox workspace-write --ask-for-approval on-request"
        )),
        AgentProvider::OpenCode => Ok(format!("{prefix}exec opencode .")),
        AgentProvider::Hermes => {
            let scope = hermes_scope
                .and_then(Path::to_str)
                .ok_or(LaunchFailure::Rejected)?;
            Ok(format!(
                "{prefix}HERMES_MANAGED_DIR={} exec hermes chat --tui",
                shell_single_quote(scope)
            ))
        }
        AgentProvider::Copilot => Ok(format!("{prefix}exec copilot")),
    }
}

#[cfg(target_os = "macos")]
fn warp_tab_config_identity(provider: AgentProvider) -> (&'static str, &'static str) {
    match provider {
        AgentProvider::Codex => ("wts_managed_codex_cli", "WTS · Codex"),
        AgentProvider::OpenCode => ("wts_managed_opencode_cli", "WTS · OpenCode"),
        AgentProvider::Hermes => ("wts_managed_hermes_cli", "WTS · Hermes"),
        AgentProvider::Copilot => ("wts_managed_copilot_cli", "WTS · Copilot"),
    }
}

#[cfg(target_os = "macos")]
fn toml_string(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len() + 2);
    escaped.push('"');
    for character in value.chars() {
        match character {
            '\\' => escaped.push_str("\\\\"),
            '"' => escaped.push_str("\\\""),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            character if character.is_control() => {
                use std::fmt::Write as _;
                let _ = write!(escaped, "\\u{:04X}", u32::from(character));
            }
            character => escaped.push(character),
        }
    }
    escaped.push('"');
    escaped
}

#[cfg(target_os = "macos")]
fn warp_tab_config(
    workspace: &Path,
    provider: AgentProvider,
    hermes_scope: Option<&Path>,
    report_helper_directory: &Path,
) -> Result<String, LaunchFailure> {
    let workspace_str = workspace.to_str().ok_or(LaunchFailure::Rejected)?;
    let (_, display_name) = warp_tab_config_identity(provider);
    let workspace_label = workspace_str
        .rsplit('/')
        .find(|part| !part.is_empty())
        .unwrap_or("workspace");
    Ok(format!(
        "# Managed by WTS. Rewritten when this provider is opened from WTS.\n\
         name = {}\n\
         title = {}\n\n\
         [[panes]]\n\
         id = \"workspace_cli\"\n\
         type = \"terminal\"\n\
         directory = {}\n\
         commands = [{}]\n\
         is_focused = true\n",
        toml_string(display_name),
        toml_string(&format!("{display_name} · {workspace_label}")),
        toml_string(workspace_str),
        toml_string(&provider_cli_command(
            workspace,
            provider,
            hermes_scope,
            report_helper_directory,
        )?),
    ))
}

#[cfg(target_os = "macos")]
fn warp_tab_config_root() -> Result<PathBuf, LaunchFailure> {
    let home = std::env::var_os("HOME").ok_or(LaunchFailure::Unavailable)?;
    let home = PathBuf::from(home);
    if !home.is_absolute() {
        return Err(LaunchFailure::Unavailable);
    }
    Ok(home.join(".warp").join("tab_configs"))
}

#[cfg(target_os = "macos")]
fn write_warp_tab_config(
    workspace: &Path,
    provider: AgentProvider,
    hermes_scope: Option<&Path>,
    report_helper_directory: &Path,
) -> Result<&'static str, LaunchFailure> {
    write_warp_tab_config_in(
        &warp_tab_config_root()?,
        workspace,
        provider,
        hermes_scope,
        report_helper_directory,
    )
}

#[cfg(target_os = "macos")]
fn write_warp_tab_config_in(
    config_root: &Path,
    workspace: &Path,
    provider: AgentProvider,
    hermes_scope: Option<&Path>,
    report_helper_directory: &Path,
) -> Result<&'static str, LaunchFailure> {
    const MANAGED_MARKER: &str = "# Managed by WTS.";
    let (config_stem, _) = warp_tab_config_identity(provider);
    fs::create_dir_all(config_root).map_err(map_launch_error)?;
    let path = config_root.join(format!("{config_stem}.toml"));
    if path.exists() {
        let existing = fs::read_to_string(&path).map_err(map_launch_error)?;
        if !existing.starts_with(MANAGED_MARKER) {
            return Err(LaunchFailure::Rejected);
        }
    }
    let temporary_path = config_root.join(format!(".{config_stem}-{}.tmp", Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary_path)
        .map_err(map_launch_error)?;
    file.write_all(
        warp_tab_config(workspace, provider, hermes_scope, report_helper_directory)?.as_bytes(),
    )
    .map_err(map_launch_error)?;
    file.flush().map_err(map_launch_error)?;
    fs::rename(&temporary_path, &path).map_err(|error| {
        let _ = fs::remove_file(&temporary_path);
        map_launch_error(error)
    })?;
    Ok(config_stem)
}

#[cfg(target_os = "macos")]
fn report_helper_directory() -> Result<PathBuf, LaunchFailure> {
    let executable = std::env::current_exe().map_err(map_launch_error)?;
    let directory = executable
        .parent()
        .filter(|directory| directory.is_absolute())
        .ok_or(LaunchFailure::Unavailable)?;
    let helper = directory.join("wts-report");
    let metadata = helper.symlink_metadata().map_err(map_launch_error)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.mode() & 0o111 == 0 {
        return Err(LaunchFailure::Unavailable);
    }
    Ok(directory.to_path_buf())
}

#[cfg(target_os = "macos")]
fn hermes_workspace_scope_root() -> Result<PathBuf, LaunchFailure> {
    let home = std::env::var_os("HOME").ok_or(LaunchFailure::Unavailable)?;
    let home = PathBuf::from(home);
    if !home.is_absolute() {
        return Err(LaunchFailure::Unavailable);
    }
    Ok(home
        .join("Library")
        .join("Application Support")
        .join("WTS")
        .join("hermes-workspaces"))
}

#[cfg(target_os = "macos")]
fn write_hermes_workspace_scope(workspace: &Path) -> Result<PathBuf, LaunchFailure> {
    let terminal_config = read_hermes_terminal_config(hermes_config_program())?;
    write_hermes_workspace_scope_in(&hermes_workspace_scope_root()?, workspace, &terminal_config)
}

#[cfg(target_os = "macos")]
fn hermes_config_program() -> PathBuf {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    hermes_config_program_in(home.as_deref())
}

#[cfg(target_os = "macos")]
fn hermes_config_program_in(home: Option<&Path>) -> PathBuf {
    home.map(|home| home.join(".local").join("bin").join("hermes"))
        .filter(|candidate| candidate.is_file())
        .unwrap_or_else(|| PathBuf::from("hermes"))
}

#[cfg(target_os = "macos")]
fn read_hermes_terminal_config(
    program: impl AsRef<std::ffi::OsStr>,
) -> Result<serde_json::Value, LaunchFailure> {
    let output = Command::new(program)
        .args(["config", "get", "terminal", "--json"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .env_remove("HERMES_MANAGED_DIR")
        .output()
        .map_err(map_launch_error)?;
    if !output.status.success() || output.stdout.len() > 64 * 1024 {
        return Err(LaunchFailure::Rejected);
    }
    let config = serde_json::from_slice::<serde_json::Value>(&output.stdout)
        .map_err(|_| LaunchFailure::Rejected)?;
    if !config.is_object() {
        return Err(LaunchFailure::Rejected);
    }
    Ok(config)
}

#[cfg(target_os = "macos")]
fn hermes_workspace_overlay(
    workspace: &Path,
    terminal_config: &serde_json::Value,
) -> Result<serde_json::Value, LaunchFailure> {
    let workspace = workspace.to_str().ok_or(LaunchFailure::Rejected)?;
    let backend = terminal_config
        .get("backend")
        .or_else(|| terminal_config.get("env_type"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("local");

    let terminal = match backend {
        "local" => serde_json::json!({
            "cwd": workspace
        }),
        "docker" => {
            let mut volumes = terminal_config
                .get("docker_volumes")
                .and_then(serde_json::Value::as_array)
                .map(|volumes| {
                    volumes
                        .iter()
                        .map(|volume| {
                            volume
                                .as_str()
                                .map(str::to_owned)
                                .ok_or(LaunchFailure::Rejected)
                        })
                        .collect::<Result<Vec<_>, _>>()
                })
                .transpose()?
                .unwrap_or_default();
            // The selected WTS workspace owns /workspace for this launch.
            // Preserve every other user-configured Docker volume.
            volumes.retain(|volume| {
                !(volume.ends_with(":/workspace") || volume.contains(":/workspace:"))
            });
            volumes.push(format!("{workspace}:/workspace"));
            serde_json::json!({
                // Hermes's TUI records terminal.cwd as the per-session command
                // cwd. It must therefore be the container path, not the host
                // bind source, or its persistent shell prepends `cd <host>`.
                "cwd": "/workspace",
                "docker_volumes": volumes,
                "docker_mount_cwd_to_workspace": false,
                // Hermes normally reuses one labeled Docker container across
                // processes without comparing its mounts. A WTS launch must
                // get a fresh container so a previous workspace's /workspace
                // bind cannot leak into this one.
                "docker_persist_across_processes": false
            })
        }
        _ => return Err(LaunchFailure::Rejected),
    };

    Ok(serde_json::json!({
        "_wts_managed": true,
        "terminal": terminal
    }))
}

#[cfg(target_os = "macos")]
fn write_hermes_workspace_scope_in(
    scopes_root: &Path,
    workspace: &Path,
    terminal_config: &serde_json::Value,
) -> Result<PathBuf, LaunchFailure> {
    let workspace = workspace.to_str().ok_or(LaunchFailure::Rejected)?;
    let scope_id = hex::encode(Sha256::digest(workspace.as_bytes()));
    let scope = scopes_root.join(&scope_id[..24]);
    fs::create_dir_all(&scope).map_err(map_launch_error)?;
    fs::set_permissions(&scope, fs::Permissions::from_mode(0o700)).map_err(map_launch_error)?;

    let config_path = scope.join("config.yaml");
    if config_path.exists() {
        let existing = fs::read_to_string(&config_path).map_err(map_launch_error)?;
        let managed = serde_json::from_str::<serde_json::Value>(&existing)
            .ok()
            .and_then(|value| value["_wts_managed"].as_bool())
            == Some(true);
        if !managed {
            return Err(LaunchFailure::Rejected);
        }
    }

    // JSON is valid YAML, so Hermes can consume this without WTS needing a
    // second serializer. The overlay changes only workspace routing leaves;
    // model, preferences, sessions, backend, and unrelated volumes stay intact.
    let config = serde_json::to_vec_pretty(&hermes_workspace_overlay(
        Path::new(workspace),
        terminal_config,
    )?)
    .map_err(|_| LaunchFailure::Rejected)?;
    let temporary_path = scope.join(format!(".config-{}.tmp", Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary_path)
        .map_err(map_launch_error)?;
    file.write_all(&config).map_err(map_launch_error)?;
    file.write_all(b"\n").map_err(map_launch_error)?;
    file.flush().map_err(map_launch_error)?;
    fs::rename(&temporary_path, &config_path).map_err(|error| {
        let _ = fs::remove_file(&temporary_path);
        map_launch_error(error)
    })?;
    Ok(scope)
}

#[cfg(target_os = "macos")]
fn warp_cli_command(config_stem: &str) -> Command {
    let mut command = Command::new("open");
    command
        .arg(format!("warp://tab_config/{config_stem}?new_window=true"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
}

#[cfg(target_os = "macos")]
fn browser_command(target: &RepositoryBaseTarget) -> Command {
    let mut command = Command::new("open");
    command
        .arg(target.web_url())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
}

#[cfg(target_os = "macos")]
fn change_request_browser_command(target: &ChangeRequestDraftTarget) -> Command {
    let mut command = Command::new("open");
    command
        .arg(target.web_url())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
}

#[cfg(target_os = "macos")]
fn github_review_browser_command(target: &GithubReviewTarget) -> Command {
    let mut command = Command::new("open");
    command
        .arg(target.web_url())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
}

#[cfg(target_os = "macos")]
fn gitlab_merge_request_browser_command(target: &GitlabMergeRequestTarget) -> Command {
    let mut command = Command::new("open");
    command
        .arg(target.web_url())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
}

#[cfg(target_os = "macos")]
fn jira_browser_command(target: &JiraIssueTarget) -> Command {
    let mut command = Command::new("open");
    command
        .arg(target.browser_url())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "macos")]
    use std::ffi::OsStr;

    #[cfg(target_os = "macos")]
    #[test]
    fn cli_launch_passes_workspace_as_argv_and_keeps_provider_commands_fixed() {
        let workspace = Path::new("/tmp/workspace with ' quotes; touch sentinel");
        let hermes_scope = Path::new("/tmp/WTS scope with ' quotes");
        let report_helper_directory = Path::new("/tmp/WTS helper with ' quotes");
        for (provider, expected) in [
            (
                AgentProvider::Codex,
                "exec codex --sandbox workspace-write --ask-for-approval on-request",
            ),
            (AgentProvider::OpenCode, "exec opencode ."),
            (AgentProvider::Hermes, "exec hermes chat --tui"),
            (AgentProvider::Copilot, "exec copilot"),
        ] {
            let scope = (provider == AgentProvider::Hermes).then_some(hermes_scope);
            let command = terminal_cli_command(workspace, provider, scope, report_helper_directory)
                .expect("terminal command");
            let arguments = command.get_args().collect::<Vec<_>>();
            assert_eq!(command.get_program(), OsStr::new("osascript"));
            assert_eq!(
                arguments.len(),
                if provider == AgentProvider::Hermes {
                    5
                } else {
                    4
                }
            );
            assert_eq!(arguments[0], OsStr::new("-e"));
            assert_eq!(arguments[2], workspace.as_os_str());
            assert_eq!(arguments[3], report_helper_directory.as_os_str());
            if provider == AgentProvider::Hermes {
                assert_eq!(arguments[4], hermes_scope.as_os_str());
            }

            let script = arguments[1].to_str().expect("static UTF-8 AppleScript");
            assert!(script.contains("quoted form of workspacePath"));
            assert!(script.contains("quoted form of reportHelperDirectory"));
            assert!(script.contains("export WTS_WORKSPACE_DIR="));
            assert!(script.contains(":$PATH "));
            assert!(script.contains(expected));
            assert!(!script.contains(workspace.to_str().expect("UTF-8 test path")));
            assert!(!script.contains(report_helper_directory.to_str().expect("UTF-8 helper path")));
            assert!(!script.contains(hermes_scope.to_str().expect("UTF-8 Hermes scope test path")));
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn warp_launch_writes_a_managed_tab_config_with_workspace_and_command() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().expect("temporary Warp config root");
        let workspace = Path::new("/tmp/workspace with \"quotes\" and \\ slash");
        let report_helper_directory = Path::new("/tmp/WTS helper with ' quotes");
        let stem = write_warp_tab_config_in(
            root.path(),
            workspace,
            AgentProvider::Codex,
            None,
            report_helper_directory,
        )
        .expect("Warp Tab Config");
        assert_eq!(stem, "wts_managed_codex_cli");
        let config_path = root.path().join("wts_managed_codex_cli.toml");
        let config = fs::read_to_string(&config_path).expect("read Warp Tab Config");
        assert!(config.starts_with("# Managed by WTS."));
        assert!(!config.contains(".command"));
        assert_eq!(
            fs::metadata(&config_path)
                .expect("Warp Tab Config metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );

        let parsed = toml::from_str::<toml::Value>(&config).expect("valid Warp Tab Config TOML");
        let pane = parsed["panes"]
            .as_array()
            .and_then(|panes| panes.first())
            .expect("single Warp terminal pane");
        assert_eq!(
            pane["directory"].as_str(),
            Some("/tmp/workspace with \"quotes\" and \\ slash")
        );
        assert_eq!(pane["type"].as_str(), Some("terminal"));
        assert_eq!(pane["is_focused"].as_bool(), Some(true));
        assert_eq!(
            pane["commands"]
                .as_array()
                .and_then(|commands| commands.first())
                .and_then(toml::Value::as_str),
            Some(
                "export WTS_WORKSPACE_DIR='/tmp/workspace with \"quotes\" and \\ slash' && PATH='/tmp/WTS helper with '\\'' quotes':\"$PATH\" exec codex --sandbox workspace-write --ask-for-approval on-request"
            )
        );

        let command = warp_cli_command(stem);
        let arguments = command.get_args().collect::<Vec<_>>();
        assert_eq!(command.get_program(), OsStr::new("open"));
        assert_eq!(
            arguments,
            [OsStr::new(
                "warp://tab_config/wts_managed_codex_cli?new_window=true"
            )]
        );

        write_warp_tab_config_in(
            root.path(),
            Path::new("/tmp/another-workspace"),
            AgentProvider::Codex,
            None,
            report_helper_directory,
        )
        .expect("update managed Warp Tab Config");
        let updated = toml::from_str::<toml::Value>(
            &fs::read_to_string(&config_path).expect("read updated Warp Tab Config"),
        )
        .expect("valid updated Warp Tab Config TOML");
        assert_eq!(
            updated["panes"][0]["directory"].as_str(),
            Some("/tmp/another-workspace")
        );
        assert_eq!(
            fs::read_dir(root.path())
                .expect("Warp config directory")
                .filter_map(Result::ok)
                .filter(|entry| entry.path().extension() == Some(OsStr::new("toml")))
                .count(),
            1
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn warp_launch_does_not_overwrite_an_unmanaged_tab_config() {
        let root = tempfile::tempdir().expect("temporary Warp config root");
        let path = root.path().join("wts_managed_codex_cli.toml");
        fs::write(&path, "name = \"User-owned config\"\n").expect("user-owned fixture");

        let result = write_warp_tab_config_in(
            root.path(),
            Path::new("/tmp/workspace"),
            AgentProvider::Codex,
            None,
            Path::new("/tmp/wts-helper"),
        );

        assert_eq!(result, Err(LaunchFailure::Rejected));
        assert_eq!(
            fs::read_to_string(path).expect("unchanged user-owned fixture"),
            "name = \"User-owned config\"\n"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn hermes_launch_exposes_the_host_workspace_to_its_docker_backend() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().expect("temporary Hermes launch root");
        let workspace = root.path().join("workspace with spaces");
        fs::create_dir(&workspace).expect("workspace fixture");
        let scopes_root = root.path().join("scopes with ' quote");
        let terminal_config = serde_json::json!({
            "backend": "docker",
            "docker_volumes": [
                "/host/cache:/cache",
                "/old/workspace:/workspace",
                "/host/data:/workspace-data"
            ]
        });
        let scope = write_hermes_workspace_scope_in(&scopes_root, &workspace, &terminal_config)
            .expect("Hermes scope");
        let config_path = scope.join("config.yaml");
        let config = serde_json::from_str::<serde_json::Value>(
            &fs::read_to_string(&config_path).expect("Hermes managed config"),
        )
        .expect("JSON is valid YAML");
        assert_eq!(config["_wts_managed"], true);
        assert_eq!(config["terminal"]["cwd"].as_str(), Some("/workspace"));
        assert_eq!(
            config["terminal"]["docker_mount_cwd_to_workspace"].as_bool(),
            Some(false)
        );
        assert_eq!(
            config["terminal"]["docker_persist_across_processes"].as_bool(),
            Some(false)
        );
        assert_eq!(
            config["terminal"]["docker_volumes"],
            serde_json::json!([
                "/host/cache:/cache",
                "/host/data:/workspace-data",
                format!("{}:/workspace", workspace.to_string_lossy())
            ])
        );
        assert_eq!(
            fs::metadata(&scope)
                .expect("Hermes scope metadata")
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(&config_path)
                .expect("Hermes config metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );

        let bin = root.path().join("bin");
        fs::create_dir(&bin).expect("fake executable directory");
        let command = provider_cli_command(&workspace, AgentProvider::Hermes, Some(&scope), &bin)
            .expect("Hermes command");
        assert!(command.starts_with("export WTS_WORKSPACE_DIR="));
        assert!(command.contains("PATH="));
        assert!(command.contains(" HERMES_MANAGED_DIR="));
        assert!(command.ends_with(" exec hermes chat --tui"));
        assert!(command.contains("'\\''"));

        let fake_hermes = bin.join("hermes");
        fs::write(
            &fake_hermes,
            "#!/bin/sh\nprintf '%s\\n' \"$PWD\" \"$HERMES_MANAGED_DIR\" \"$WTS_WORKSPACE_DIR\" \"$*\"\n",
        )
        .expect("fake Hermes executable");
        fs::set_permissions(&fake_hermes, fs::Permissions::from_mode(0o700))
            .expect("fake Hermes permissions");
        let path = std::env::join_paths(std::iter::once(bin.clone()).chain(std::env::split_paths(
            &std::env::var_os("PATH").unwrap_or_default(),
        )))
        .expect("fixture PATH");
        let output = Command::new("/bin/sh")
            .arg("-c")
            .arg(&command)
            .current_dir(&workspace)
            .env("PATH", path)
            .output()
            .expect("execute the same Hermes launch command");
        assert!(output.status.success());
        let lines = String::from_utf8(output.stdout)
            .expect("UTF-8 fixture output")
            .lines()
            .map(str::to_owned)
            .collect::<Vec<_>>();
        assert_eq!(
            lines,
            [
                workspace
                    .canonicalize()
                    .expect("canonical workspace fixture")
                    .to_string_lossy()
                    .into_owned(),
                scope.to_string_lossy().into_owned(),
                workspace.to_string_lossy().into_owned(),
                "chat --tui".to_owned(),
            ]
        );

        let warp_root = root.path().join("warp");
        write_warp_tab_config_in(
            &warp_root,
            &workspace,
            AgentProvider::Hermes,
            Some(&scope),
            &bin,
        )
        .expect("Hermes Warp config");
        let warp = toml::from_str::<toml::Value>(
            &fs::read_to_string(warp_root.join("wts_managed_hermes_cli.toml"))
                .expect("Hermes Warp config"),
        )
        .expect("valid Hermes Warp TOML");
        assert_eq!(warp["panes"][0]["directory"].as_str(), workspace.to_str());
        assert_eq!(
            warp["panes"][0]["commands"][0].as_str(),
            Some(command.as_str())
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn hermes_scope_does_not_overwrite_an_unmanaged_config() {
        let root = tempfile::tempdir().expect("temporary Hermes launch root");
        let workspace = Path::new("/tmp/workspace");
        let scope_id = hex::encode(Sha256::digest(
            workspace.to_str().expect("UTF-8 fixture").as_bytes(),
        ));
        let scope = root.path().join(&scope_id[..24]);
        fs::create_dir(&scope).expect("scope fixture");
        let config_path = scope.join("config.yaml");
        fs::write(&config_path, "{\"terminal\":{\"cwd\":\"user-owned\"}}\n")
            .expect("unmanaged fixture");

        let result = write_hermes_workspace_scope_in(
            root.path(),
            workspace,
            &serde_json::json!({"backend": "local"}),
        );

        assert_eq!(result, Err(LaunchFailure::Rejected));
        assert_eq!(
            fs::read_to_string(config_path).expect("unchanged unmanaged fixture"),
            "{\"terminal\":{\"cwd\":\"user-owned\"}}\n"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn hermes_terminal_config_is_read_through_a_fixed_json_command() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().expect("temporary fake Hermes root");
        let fake_hermes = root.path().join("hermes");
        fs::write(
            &fake_hermes,
            "#!/bin/sh\n\
             test \"$1\" = config || exit 10\n\
             test \"$2\" = get || exit 11\n\
             test \"$3\" = terminal || exit 12\n\
             test \"$4\" = --json || exit 13\n\
             test \"$#\" = 4 || exit 14\n\
             printf '%s\\n' '{\"backend\":\"docker\",\"docker_volumes\":[\"/cache:/cache\"]}'\n",
        )
        .expect("fake Hermes config executable");
        fs::set_permissions(&fake_hermes, fs::Permissions::from_mode(0o700))
            .expect("fake Hermes permissions");

        let config =
            read_hermes_terminal_config(&fake_hermes).expect("resolved Hermes terminal config");

        assert_eq!(config["backend"], "docker");
        assert_eq!(
            config["docker_volumes"],
            serde_json::json!(["/cache:/cache"])
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn hermes_config_probe_prefers_the_standard_user_install_without_shell_path() {
        let root = tempfile::tempdir().expect("temporary fake home");
        let expected = root.path().join(".local/bin/hermes");
        fs::create_dir_all(expected.parent().expect("fake bin parent"))
            .expect("fake Hermes bin directory");
        fs::write(&expected, "").expect("fake Hermes install");

        assert_eq!(hermes_config_program_in(Some(root.path())), expected);
        assert_eq!(
            hermes_config_program_in(Some(Path::new("/missing/home"))),
            PathBuf::from("hermes")
        );
        assert_eq!(hermes_config_program_in(None), PathBuf::from("hermes"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn hermes_local_backend_keeps_the_host_workspace_as_its_process_cwd() {
        let workspace = Path::new("/tmp/local workspace");

        let overlay = hermes_workspace_overlay(
            workspace,
            &serde_json::json!({"backend": "local", "docker_volumes": ["/cache:/cache"]}),
        )
        .expect("local Hermes overlay");

        assert_eq!(overlay["terminal"]["cwd"].as_str(), workspace.to_str());
        assert!(overlay["terminal"].get("docker_volumes").is_none());
    }

    #[test]
    fn forge_targets_use_commit_deep_links_for_public_and_enterprise_hosts() {
        let github = RepositoryBaseTarget::from_origin(
            "https://github.com/acme/payments.git",
            "1111111111111111111111111111111111111111",
        )
        .expect("GitHub target");
        assert_eq!(github.forge(), RepositoryForge::Github);
        assert_eq!(github.host(), "github.com");
        assert_eq!(github.repository_path(), "acme/payments");
        assert_eq!(
            github.web_url(),
            "https://github.com/acme/payments/tree/1111111111111111111111111111111111111111"
        );

        let gitlab = RepositoryBaseTarget::from_origin(
            "git@gitlab.example.test:payments/platform/provisioning.git",
            "2222222222222222222222222222222222222222",
        )
        .expect("enterprise GitLab target");
        assert_eq!(gitlab.forge(), RepositoryForge::Gitlab);
        assert_eq!(gitlab.host(), "gitlab.example.test");
        assert_eq!(gitlab.repository_path(), "payments/platform/provisioning");
        assert_eq!(
            gitlab.web_url(),
            "https://gitlab.example.test/payments/platform/provisioning/-/tree/2222222222222222222222222222222222222222"
        );
    }

    #[test]
    fn forge_targets_reject_untrusted_origin_shapes() {
        let oid = "1111111111111111111111111111111111111111";
        for origin in [
            "https://github.com/acme/../admin.git",
            "https://notgithub.example.com/acme/api.git",
            "https://example-gitlab.com/acme/api.git",
            "file:///tmp/acme/api.git",
            "http://github.com/acme/api.git",
            "git+ssh://github.com/acme/api.git",
            "ext::ssh github.com acme/api.git",
            "/tmp/acme/api",
            "github.com:acme/%2e%2e/api.git",
            "github.com:acme/api.git?token=secret",
            "github.com:acme/api/extra.git",
        ] {
            assert_eq!(
                RepositoryBaseTarget::from_origin(origin, oid),
                None,
                "origin should be rejected: {origin}"
            );
        }
        assert_eq!(
            RepositoryBaseTarget::from_origin("github.com:acme/api.git", "not-an-oid"),
            None
        );

        let credential_sanitized =
            RepositoryBaseTarget::from_origin("https://user:secret@github.com/acme/api.git", oid)
                .expect("URL userinfo is dropped");
        assert_eq!(credential_sanitized.host(), "github.com");
        assert!(!credential_sanitized.web_url().contains("user"));
        assert!(!credential_sanitized.web_url().contains("secret"));
    }

    #[test]
    fn change_request_targets_prefill_gitlab_and_github_forms() {
        let oid = "1111111111111111111111111111111111111111";
        let gitlab = ChangeRequestDraftTarget::from_remote(
            "git@gitlab.example.test:payments/platform/api.git",
            "feat/PLATFORM-7197",
            "main",
            oid,
            "PLATFORM-7197: Validate admission",
            "## Summary\n\n- Validate PPEC state.",
        )
        .expect("GitLab draft");
        assert_eq!(gitlab.forge(), RepositoryForge::Gitlab);
        assert!(gitlab.web_url().starts_with(
            "https://gitlab.example.test/payments/platform/api/-/merge_requests/new?"
        ));
        assert!(
            gitlab
                .web_url()
                .contains("merge_request%5Bsource_branch%5D=feat%2FPLATFORM-7197")
        );
        assert!(
            gitlab
                .web_url()
                .contains("merge_request%5Btarget_branch%5D=main")
        );
        assert!(
            gitlab
                .web_url()
                .contains("merge_request%5Btitle%5D=PLATFORM-7197%3A+Validate+admission")
        );

        let github = ChangeRequestDraftTarget::from_remote(
            "https://github.com/acme/api.git",
            "feat/retry",
            "main",
            oid,
            "Add retry support",
            "## Summary\n\n- Retry.",
        )
        .expect("GitHub draft");
        assert_eq!(github.forge(), RepositoryForge::Github);
        assert!(
            github
                .web_url()
                .starts_with("https://github.com/acme/api/compare/main...feat/retry?quick_pull=1")
        );
        assert!(github.web_url().contains("title=Add+retry+support"));
    }

    #[test]
    fn change_request_targets_reject_unsafe_or_oversized_fields() {
        let oid = "1111111111111111111111111111111111111111";
        for source in ["../admin", "feat?token=secret", "feat branch", "-danger"] {
            assert!(
                ChangeRequestDraftTarget::from_remote(
                    "https://github.com/acme/api.git",
                    source,
                    "main",
                    oid,
                    "Safe title",
                    "Safe body",
                )
                .is_none()
            );
        }
        assert!(
            ChangeRequestDraftTarget::from_remote(
                "https://github.com/acme/api.git",
                "feat/safe",
                "main",
                oid,
                &"x".repeat(257),
                "Safe body",
            )
            .is_none()
        );
    }

    #[test]
    fn github_review_targets_use_only_github_catalog_origins_and_pr_numbers() {
        let target = GithubReviewTarget::from_origin("git@github.com:acme/api.git", 17)
            .expect("GitHub review target");
        assert_eq!(target.repository_path(), "acme/api");
        assert_eq!(target.number(), 17);
        assert_eq!(target.web_url(), "https://github.com/acme/api/pull/17");
        assert!(GithubReviewTarget::from_origin("https://evil.example/acme/api", 17).is_none());
        assert!(GithubReviewTarget::from_origin("https://github.com/acme/api", 0).is_none());
    }

    #[test]
    fn gitlab_merge_request_targets_use_only_gitlab_origins_and_iids() {
        let target = GitlabMergeRequestTarget::from_origin(
            "git@gitlab.example.test:payments/platform/api.git",
            17,
        )
        .expect("GitLab merge request target");
        assert_eq!(target.host(), "gitlab.example.test");
        assert_eq!(target.repository_path(), "payments/platform/api");
        assert_eq!(target.iid(), 17);
        assert_eq!(
            target.web_url(),
            "https://gitlab.example.test/payments/platform/api/-/merge_requests/17"
        );
        assert!(
            GitlabMergeRequestTarget::from_origin("https://evil.example/acme/api", 17).is_none()
        );
        for origin in [
            "https://user@gitlab.example.com/acme/api",
            "https://git@gitlab.com/acme/api",
            "https://gitlab.com:8443/acme/api",
            "ssh://user@gitlab.example.com/acme/api",
            "ssh://git@gitlab.com:2222/acme/api",
        ] {
            assert!(
                GitlabMergeRequestTarget::from_origin(origin, 17).is_none(),
                "origin should be rejected: {origin}"
            );
        }
        assert!(GitlabMergeRequestTarget::from_origin("https://gitlab.com/acme/api", 0).is_none());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn browser_launch_uses_one_fixed_open_argument_without_a_shell() {
        let target = RepositoryBaseTarget::from_origin(
            "https://github.com/acme/payments.git",
            "1111111111111111111111111111111111111111",
        )
        .expect("target");
        let command = browser_command(&target);
        assert_eq!(command.get_program(), OsStr::new("open"));
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            [OsStr::new(target.web_url())]
        );
    }

    #[test]
    fn jira_targets_reject_arbitrary_urls() {
        assert!(
            JiraIssueTarget::from_browser_url(
                "PLATFORM-42",
                "https://jira.example.test/browse/PLATFORM-42",
            )
            .is_some()
        );
        assert!(
            JiraIssueTarget::from_browser_url(
                "PLATFORM-42",
                "https://jira.example/products/jira/browse/PLATFORM-42",
            )
            .is_some()
        );
        for url in [
            "https://jira.example.test/browse/OTHER-1",
            "https://user@jira.example.test/browse/PLATFORM-42",
            "https://jira.example.test/browse/PLATFORM-42?token=secret",
            "http://jira.example.test/browse/PLATFORM-42",
        ] {
            assert!(
                JiraIssueTarget::from_browser_url("PLATFORM-42", url).is_none(),
                "target must be rejected: {url}",
            );
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn jira_launch_uses_one_fixed_open_argument_without_a_shell() {
        let target = JiraIssueTarget::from_browser_url(
            "PLATFORM-42",
            "https://jira.example.test/browse/PLATFORM-42",
        )
        .expect("Jira target");
        let command = jira_browser_command(&target);
        assert_eq!(command.get_program(), OsStr::new("open"));
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            [OsStr::new(target.browser_url())]
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn vscode_launch_uses_the_macos_application_handoff_without_shell_path() {
        let workspace = Path::new("/tmp/workspace with spaces/task.code-workspace");
        let command = vscode_command(workspace);

        assert_eq!(command.get_program(), OsStr::new("/usr/bin/open"));
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            [
                OsStr::new("-a"),
                OsStr::new("Visual Studio Code"),
                workspace.as_os_str(),
            ]
        );
    }
}
