use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    borrow::Cow,
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc::{self, Receiver, RecvTimeoutError},
    thread,
    time::{Duration, Instant},
};

const MAX_HOST_CONFIG_BYTES: u64 = 1024 * 1024;
const MAX_MCP_MESSAGE_BYTES: usize = 2 * 1024 * 1024;
const MAX_ISSUE_CONTENT_BYTES: usize = 512 * 1024;
const MCP_TIMEOUT: Duration = Duration::from_secs(20);
const MCP_STARTUP_TIMEOUT: Duration = Duration::from_secs(60);
const MCP_PROTOCOL_VERSION: &str = "2025-11-25";
const MCP_ATLASSIAN_IMAGE: &str = "ghcr.io/sooperset/mcp-atlassian";
const MAX_TOOL_LIST_PAGES: usize = 32;
const MAX_ACTIVE_ISSUES: usize = 20;
const ACTIVE_ISSUES_JQL: &str =
    "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JiraMcpVerification {
    pub connected: bool,
    pub server_name: String,
    pub server_version: String,
    pub issue_tool: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JiraIssue {
    pub issue_key: String,
    pub summary: Option<String>,
    pub status: Option<String>,
    pub content: String,
    pub browser_url: Option<String>,
}

impl JiraIssue {
    /// Extracts display text without changing the saved provider response.
    pub fn description(&self) -> Cow<'_, str> {
        if self.content.len() > MAX_ISSUE_CONTENT_BYTES {
            return Cow::Borrowed(&self.content);
        }
        let Ok(value) = serde_json::from_str::<Value>(&self.content) else {
            return Cow::Borrowed(&self.content);
        };
        let key = value.get("key").or_else(|| value.get("issue_key"));
        if key.and_then(Value::as_str) != Some(self.issue_key.as_str()) {
            return Cow::Borrowed(&self.content);
        }
        if value
            .get("key")
            .is_some_and(|key| key.as_str() != Some(self.issue_key.as_str()))
            || value
                .get("issue_key")
                .is_some_and(|key| key.as_str() != Some(self.issue_key.as_str()))
        {
            return Cow::Borrowed(&self.content);
        }
        let description = value
            .get("fields")
            .and_then(|fields| fields.get("description"))
            .or_else(|| value.get("description"));
        match description {
            Some(Value::String(description)) if !description.trim().is_empty() => {
                Cow::Owned(description.clone())
            }
            Some(Value::Null) | Some(Value::String(_)) => Cow::Borrowed(
                "No Jira description was available when this planning home was created.",
            ),
            _ => Cow::Borrowed(&self.content),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JiraActiveIssue {
    pub issue_key: String,
    pub summary: String,
    pub status: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JiraActiveIssueList {
    pub schema_version: u8,
    pub issues: Vec<JiraActiveIssue>,
    pub detail: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JiraMcpError {
    InvalidIssueKey,
    ConfigurationMissing,
    ConfigurationUnsupported,
    ConfigurationInvalid,
    SpawnFailed,
    ProtocolTimedOut,
    ProtocolInvalid,
    IssueToolMissing,
    SearchToolMissing,
    ToolCallFailed,
    OutputTooLarge,
}

impl JiraMcpError {
    pub const fn safe_message(self) -> &'static str {
        match self {
            Self::InvalidIssueKey => "Enter a Jira key such as PLATFORM-42.",
            Self::ConfigurationMissing => {
                "No supported Jira MCP stdio registration was found in VS Code."
            }
            Self::ConfigurationUnsupported => {
                "The Jira MCP registration uses a command or substitution WTS does not allow."
            }
            Self::ConfigurationInvalid => "The Jira MCP registration could not be read safely.",
            Self::SpawnFailed => "WTS could not start Jira. Start Podman, then try again.",
            Self::ProtocolTimedOut => "The Jira MCP process did not answer before the timeout.",
            Self::ProtocolInvalid => "The Jira MCP process returned an invalid protocol message.",
            Self::IssueToolMissing => "The Jira MCP server does not expose jira_get_issue.",
            Self::SearchToolMissing => "The Jira MCP server does not expose jira_search.",
            Self::ToolCallFailed => "The Jira MCP server could not import that issue.",
            Self::OutputTooLarge => "The Jira MCP response exceeded WTS's local safety limit.",
        }
    }
}

#[derive(Clone, Debug)]
struct StdioRegistration {
    command: String,
    args: Vec<String>,
    env: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Deserialize)]
struct HostConfig {
    #[serde(default)]
    servers: BTreeMap<String, HostServer>,
}

#[derive(Clone, Debug, Deserialize)]
struct HostServer {
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
    #[serde(rename = "type", default)]
    transport_type: Option<String>,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct JiraMcpAdapter;

impl JiraMcpAdapter {
    /// Accepts a saved issue URL only when it still matches a validated local
    /// Jira MCP registration. Issue content cannot select the browser origin.
    pub fn trusted_issue_browser_url(
        &self,
        issue_key: &str,
        candidate: &str,
    ) -> Result<String, JiraMcpError> {
        let issue_key = validate_issue_key(issue_key)?;
        let registrations = load_vscode_registrations()?;
        trusted_configured_jira_issue_browser_url(&registrations, issue_key, candidate)
            .ok_or(JiraMcpError::ConfigurationInvalid)
    }

    pub fn verify(&self) -> Result<JiraMcpVerification, JiraMcpError> {
        let registrations = load_vscode_registrations()?;
        let mut last_error = JiraMcpError::IssueToolMissing;
        for registration in registrations {
            let result = (|| {
                let mut client = McpClient::start(&registration)?;
                let initialized = client.initialize()?;
                let issue_tool = client.issue_tool()?;
                Ok(JiraMcpVerification {
                    connected: true,
                    server_name: initialized.0,
                    server_version: initialized.1,
                    issue_tool,
                })
            })();
            match result {
                Ok(verification) => return Ok(verification),
                Err(error) => last_error = error,
            }
        }
        Err(last_error)
    }

    pub fn get_issue(&self, issue_key: &str) -> Result<JiraIssue, JiraMcpError> {
        let issue_key = validate_issue_key(issue_key)?;
        let registrations = load_vscode_registrations()?;
        let mut last_error = JiraMcpError::IssueToolMissing;
        for registration in registrations {
            let result = (|| {
                let mut client = McpClient::start(&registration)?;
                let _ = client.initialize()?;
                let issue_tool = client.issue_tool()?;
                let result = client.request_next(
                    "tools/call",
                    json!({
                        "name": issue_tool,
                        "arguments": { "issue_key": issue_key }
                    }),
                )?;
                if result
                    .get("isError")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    return Err(JiraMcpError::ToolCallFailed);
                }
                let content = extract_tool_text(&result)?;
                Ok(jira_issue_from_registration(
                    &registration,
                    issue_key,
                    content,
                ))
            })();
            match result {
                Ok(issue) => return Ok(issue),
                Err(error) => last_error = error,
            }
        }
        Err(last_error)
    }

    pub fn active_issues(&self) -> Result<JiraActiveIssueList, JiraMcpError> {
        let registrations = load_vscode_registrations()?;
        let mut last_error = JiraMcpError::SearchToolMissing;
        for registration in registrations {
            let result = (|| {
                let mut client = McpClient::start(&registration)?;
                let _ = client.initialize()?;
                let search_tool = client.search_tool()?;
                let result = client.request_next(
                    "tools/call",
                    json!({
                        "name": search_tool,
                        "arguments": {
                            "jql": ACTIVE_ISSUES_JQL,
                            "fields": "summary,status",
                            "limit": MAX_ACTIVE_ISSUES
                        }
                    }),
                )?;
                if result
                    .get("isError")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    return Err(JiraMcpError::ToolCallFailed);
                }
                let content = extract_tool_text(&result)?;
                let issues = extract_active_issues(&content)?;
                Ok(JiraActiveIssueList {
                    schema_version: 1,
                    issues,
                    detail:
                        "Assigned Jira issues that are not in the Done status category, ordered by recent updates."
                            .to_owned(),
                })
            })();
            match result {
                Ok(issues) => return Ok(issues),
                Err(error) => last_error = error,
            }
        }
        Err(last_error)
    }
}

fn jira_issue_from_registration(
    registration: &StdioRegistration,
    issue_key: &str,
    content: String,
) -> JiraIssue {
    let (summary, status) = extract_issue_fields(&content);
    JiraIssue {
        issue_key: issue_key.to_owned(),
        summary,
        status,
        content,
        browser_url: configured_jira_issue_browser_url(registration, issue_key),
    }
}

fn configured_jira_issue_browser_url(
    registration: &StdioRegistration,
    issue_key: &str,
) -> Option<String> {
    let issue_key = validate_issue_key(issue_key).ok()?;
    let configured = registration.env.get("JIRA_URL")?;
    let mut url = Url::parse(configured).ok()?;
    let host = url.host_str()?;
    if url.scheme() != "https"
        || !host.contains('.')
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    {
        let mut segments = url.path_segments_mut().ok()?;
        segments.pop_if_empty();
        segments.push("browse");
        segments.push(issue_key);
    }
    Some(url.to_string())
}

fn trusted_configured_jira_issue_browser_url(
    registrations: &[StdioRegistration],
    issue_key: &str,
    candidate: &str,
) -> Option<String> {
    registrations
        .iter()
        .filter_map(|registration| configured_jira_issue_browser_url(registration, issue_key))
        .find(|trusted| trusted == candidate)
}

fn validate_issue_key(value: &str) -> Result<&str, JiraMcpError> {
    let value = value.trim();
    let Some((project, number)) = value.rsplit_once('-') else {
        return Err(JiraMcpError::InvalidIssueKey);
    };
    if project.is_empty()
        || number.is_empty()
        || project.len() > 32
        || number.len() > 16
        || !project
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
        || !number.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(JiraMcpError::InvalidIssueKey);
    }
    Ok(value)
}

fn vscode_mcp_config_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    #[cfg(target_os = "macos")]
    if let Some(home) = std::env::var_os("HOME") {
        let root = PathBuf::from(home).join("Library/Application Support");
        paths.push(root.join("Code/User/mcp.json"));
        paths.push(root.join("Code - Insiders/User/mcp.json"));
        paths.push(root.join("VSCodium/User/mcp.json"));
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    if let Some(home) = std::env::var_os("HOME") {
        let root = PathBuf::from(home).join(".config");
        paths.push(root.join("Code/User/mcp.json"));
        paths.push(root.join("Code - Insiders/User/mcp.json"));
        paths.push(root.join("VSCodium/User/mcp.json"));
    }
    #[cfg(windows)]
    if let Some(app_data) = std::env::var_os("APPDATA") {
        let root = PathBuf::from(app_data);
        paths.push(root.join("Code/User/mcp.json"));
        paths.push(root.join("Code - Insiders/User/mcp.json"));
        paths.push(root.join("VSCodium/User/mcp.json"));
    }
    paths
}

fn load_vscode_registrations() -> Result<Vec<StdioRegistration>, JiraMcpError> {
    let mut registrations = Vec::new();
    let mut saw_candidate = false;
    let mut last_error = JiraMcpError::ConfigurationMissing;
    for path in vscode_mcp_config_paths() {
        if !path.is_file() {
            continue;
        }
        let metadata = fs::metadata(&path).map_err(|_| JiraMcpError::ConfigurationInvalid)?;
        if metadata.len() > MAX_HOST_CONFIG_BYTES {
            return Err(JiraMcpError::ConfigurationInvalid);
        }
        let text = fs::read_to_string(&path).map_err(|_| JiraMcpError::ConfigurationInvalid)?;
        let config: HostConfig =
            json5::from_str(&text).map_err(|_| JiraMcpError::ConfigurationInvalid)?;
        for (name, server) in config.servers {
            if !is_jira_registration(&name, &server) {
                continue;
            }
            saw_candidate = true;
            match validate_registration(server) {
                Ok(registration) => {
                    let fallback = uvx_fallback(&registration);
                    registrations.push(registration);
                    if let Some(fallback) = fallback {
                        registrations.push(fallback);
                    }
                }
                Err(error) => last_error = error,
            }
        }
    }
    if !registrations.is_empty() {
        Ok(registrations)
    } else if saw_candidate {
        Err(last_error)
    } else {
        Err(JiraMcpError::ConfigurationMissing)
    }
}

fn uvx_fallback(registration: &StdioRegistration) -> Option<StdioRegistration> {
    let command = Path::new(&registration.command)
        .file_name()
        .and_then(|value| value.to_str())?;
    if !matches!(command, "podman" | "docker")
        || !registration
            .args
            .iter()
            .any(|arg| arg.starts_with(MCP_ATLASSIAN_IMAGE))
    {
        return None;
    }
    let mut fallback = StdioRegistration {
        command: "uvx".to_owned(),
        args: vec!["mcp-atlassian".to_owned()],
        env: registration.env.clone(),
    };
    repair_cloud_api_token_environment(&mut fallback.env, git_identity_email().as_deref());
    Some(fallback)
}

fn repair_cloud_api_token_environment(
    env: &mut BTreeMap<String, String>,
    identity_email: Option<&str>,
) {
    let is_cloud = env
        .get("JIRA_URL")
        .is_some_and(|url| url.to_ascii_lowercase().contains(".atlassian.net"));
    let personal_token = env.get("JIRA_PERSONAL_TOKEN").cloned();
    let api_token_mislabeled = personal_token
        .as_deref()
        .is_some_and(|token| token.starts_with("ATATT"));
    let email = identity_email.filter(|email| {
        !email.is_empty()
            && email.len() <= 320
            && email.contains('@')
            && !email.chars().any(char::is_whitespace)
    });
    if !is_cloud
        || !api_token_mislabeled
        || env.contains_key("JIRA_USERNAME")
        || env.contains_key("JIRA_API_TOKEN")
        || email.is_none()
    {
        return;
    }

    env.insert("JIRA_USERNAME".to_owned(), email.unwrap().to_owned());
    env.insert("JIRA_API_TOKEN".to_owned(), personal_token.unwrap());
    env.remove("JIRA_PERSONAL_TOKEN");
}

fn git_identity_email() -> Option<String> {
    let output = Command::new("git")
        .args(["config", "--global", "--get", "user.email"])
        .output()
        .ok()?;
    if !output.status.success() || output.stdout.len() > 512 {
        return None;
    }
    String::from_utf8(output.stdout)
        .ok()
        .map(|email| email.trim().to_owned())
}

fn is_jira_registration(name: &str, server: &HostServer) -> bool {
    let name = name.to_ascii_lowercase();
    name.contains("jira")
        || name.contains("atlassian")
        || server
            .args
            .iter()
            .any(|arg| arg.to_ascii_lowercase().contains("mcp-atlassian"))
        || server.env.keys().any(|key| key.starts_with("JIRA_"))
}

fn validate_registration(server: HostServer) -> Result<StdioRegistration, JiraMcpError> {
    if server
        .transport_type
        .as_deref()
        .is_some_and(|value| value != "stdio")
    {
        return Err(JiraMcpError::ConfigurationUnsupported);
    }
    let command = server
        .command
        .ok_or(JiraMcpError::ConfigurationUnsupported)?;
    if contains_substitution(&command)
        || server.args.iter().any(|value| contains_substitution(value))
        || server
            .env
            .iter()
            .any(|(key, value)| !valid_env_key(key) || contains_substitution(value))
    {
        return Err(JiraMcpError::ConfigurationUnsupported);
    }
    if server.args.len() > 128 || server.env.len() > 64 {
        return Err(JiraMcpError::ConfigurationUnsupported);
    }

    let basename = Path::new(&command)
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or(JiraMcpError::ConfigurationUnsupported)?;
    let allowed = match basename {
        "podman" | "docker" => server
            .args
            .iter()
            .any(|arg| arg.starts_with(MCP_ATLASSIAN_IMAGE)),
        "uvx" => server.args.iter().any(|arg| arg == "mcp-atlassian"),
        "mcp-atlassian" => true,
        _ => false,
    };
    if !allowed {
        return Err(JiraMcpError::ConfigurationUnsupported);
    }
    Ok(StdioRegistration {
        command,
        args: server.args,
        env: server.env,
    })
}

fn contains_substitution(value: &str) -> bool {
    value.contains("${") || value.contains('\0')
}

fn valid_env_key(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

struct McpClient {
    child: Child,
    stdin: ChildStdin,
    messages: Receiver<Result<Value, JiraMcpError>>,
    next_request_id: u64,
}

impl McpClient {
    fn start(registration: &StdioRegistration) -> Result<Self, JiraMcpError> {
        let mut child = Command::new(&registration.command)
            .args(&registration.args)
            .envs(&registration.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| JiraMcpError::SpawnFailed)?;
        let stdin = child.stdin.take().ok_or(JiraMcpError::SpawnFailed)?;
        let stdout = child.stdout.take().ok_or(JiraMcpError::SpawnFailed)?;
        let (sender, messages) = mpsc::sync_channel(32);
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                match read_protocol_line(&mut reader) {
                    Ok(None) => break,
                    Ok(Some(line)) => {
                        let parsed = serde_json::from_slice(&line)
                            .map_err(|_| JiraMcpError::ProtocolInvalid);
                        if sender.send(parsed).is_err() {
                            break;
                        }
                    }
                    Err(error) => {
                        let _ = sender.send(Err(error));
                        break;
                    }
                }
            }
        });
        Ok(Self {
            child,
            stdin,
            messages,
            next_request_id: 1,
        })
    }

    fn initialize(&mut self) -> Result<(String, String), JiraMcpError> {
        let result = self.request_next_with_timeout(
            "initialize",
            json!({
                "protocolVersion": MCP_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {
                    "name": "wts",
                    "version": env!("CARGO_PKG_VERSION")
                }
            }),
            MCP_STARTUP_TIMEOUT,
        )?;
        self.notify("notifications/initialized", json!({}))?;
        let server = result.get("serverInfo").and_then(Value::as_object);
        let name = server
            .and_then(|value| value.get("name"))
            .and_then(Value::as_str)
            .unwrap_or("Jira MCP")
            .to_owned();
        let version = server
            .and_then(|value| value.get("version"))
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_owned();
        Ok((name, version))
    }

    fn issue_tool(&mut self) -> Result<String, JiraMcpError> {
        discover_tool("jira_get_issue", JiraMcpError::IssueToolMissing, |params| {
            self.request_next("tools/list", params)
        })
    }

    fn search_tool(&mut self) -> Result<String, JiraMcpError> {
        discover_tool("jira_search", JiraMcpError::SearchToolMissing, |params| {
            self.request_next("tools/list", params)
        })
    }

    fn request_next(&mut self, method: &str, params: Value) -> Result<Value, JiraMcpError> {
        self.request_next_with_timeout(method, params, MCP_TIMEOUT)
    }

    fn request_next_with_timeout(
        &mut self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, JiraMcpError> {
        let id = self.next_request_id;
        self.next_request_id = self
            .next_request_id
            .checked_add(1)
            .ok_or(JiraMcpError::ProtocolInvalid)?;
        self.request(id, method, params, timeout)
    }

    fn request(
        &mut self,
        id: u64,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, JiraMcpError> {
        self.send(json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        }))?;
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let message = match self.messages.recv_timeout(remaining) {
                Ok(message) => message?,
                Err(RecvTimeoutError::Timeout) => return Err(JiraMcpError::ProtocolTimedOut),
                Err(RecvTimeoutError::Disconnected) => {
                    return Err(JiraMcpError::SpawnFailed);
                }
            };
            if message.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if message.get("error").is_some() {
                return Err(JiraMcpError::ToolCallFailed);
            }
            return message
                .get("result")
                .cloned()
                .ok_or(JiraMcpError::ProtocolInvalid);
        }
    }

    fn notify(&mut self, method: &str, params: Value) -> Result<(), JiraMcpError> {
        self.send(json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        }))
    }

    fn send(&mut self, message: Value) -> Result<(), JiraMcpError> {
        serde_json::to_writer(&mut self.stdin, &message).map_err(|_| JiraMcpError::SpawnFailed)?;
        self.stdin
            .write_all(b"\n")
            .and_then(|_| self.stdin.flush())
            .map_err(|_| JiraMcpError::SpawnFailed)
    }
}

fn discover_tool(
    expected_name: &str,
    missing_error: JiraMcpError,
    mut request_page: impl FnMut(Value) -> Result<Value, JiraMcpError>,
) -> Result<String, JiraMcpError> {
    let mut cursor: Option<String> = None;
    let mut seen_cursors = BTreeSet::new();

    for _ in 0..MAX_TOOL_LIST_PAGES {
        let params = cursor
            .as_ref()
            .map_or_else(|| json!({}), |cursor| json!({ "cursor": cursor }));
        let result = request_page(params)?;
        let tools = result
            .get("tools")
            .and_then(Value::as_array)
            .ok_or(JiraMcpError::ProtocolInvalid)?;
        if tools
            .iter()
            .any(|tool| tool.get("name").and_then(Value::as_str) == Some(expected_name))
        {
            return Ok(expected_name.to_owned());
        }

        let Some(next_cursor) = result.get("nextCursor") else {
            return Err(missing_error);
        };
        let next_cursor = next_cursor
            .as_str()
            .filter(|value| !value.is_empty())
            .ok_or(JiraMcpError::ProtocolInvalid)?;
        if !seen_cursors.insert(next_cursor.to_owned()) {
            return Err(JiraMcpError::ProtocolInvalid);
        }
        cursor = Some(next_cursor.to_owned());
    }

    Err(JiraMcpError::ProtocolInvalid)
}

fn extract_active_issues(content: &str) -> Result<Vec<JiraActiveIssue>, JiraMcpError> {
    let value: Value = serde_json::from_str(content).map_err(|_| JiraMcpError::ProtocolInvalid)?;
    let issue_values = if let Some(issues) = value.get("issues").and_then(Value::as_array) {
        issues
    } else if let Some(issues) = value.as_array() {
        issues
    } else {
        return Err(JiraMcpError::ProtocolInvalid);
    };
    if issue_values.len() > MAX_ACTIVE_ISSUES {
        return Err(JiraMcpError::OutputTooLarge);
    }
    let mut issues = Vec::with_capacity(issue_values.len());
    let mut seen = BTreeSet::new();
    for issue in issue_values {
        let key = issue
            .get("key")
            .or_else(|| issue.get("issue_key"))
            .and_then(Value::as_str)
            .ok_or(JiraMcpError::ProtocolInvalid)?;
        let key = validate_issue_key(key)?.to_owned();
        if !seen.insert(key.clone()) {
            continue;
        }
        let summary = find_string(issue, &["fields", "summary"])
            .or_else(|| find_string(issue, &["summary"]))
            .filter(|value| !value.trim().is_empty())
            .ok_or(JiraMcpError::ProtocolInvalid)?;
        let status = find_string(issue, &["fields", "status", "name"])
            .or_else(|| find_string(issue, &["status", "name"]))
            .or_else(|| find_string(issue, &["status"]))
            .filter(|value| !value.trim().is_empty())
            .ok_or(JiraMcpError::ProtocolInvalid)?;
        if summary.len() > 512 || status.len() > 128 {
            return Err(JiraMcpError::OutputTooLarge);
        }
        issues.push(JiraActiveIssue {
            issue_key: key,
            summary,
            status,
        });
    }
    Ok(issues)
}

impl Drop for McpClient {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn extract_tool_text(result: &Value) -> Result<String, JiraMcpError> {
    let mut parts = Vec::new();
    if let Some(content) = result.get("content").and_then(Value::as_array) {
        for item in content {
            if item.get("type").and_then(Value::as_str) == Some("text")
                && let Some(text) = item.get("text").and_then(Value::as_str)
            {
                parts.push(text);
            }
        }
    }
    if !parts.is_empty() {
        let text = parts.join("\n");
        if text.len() > MAX_ISSUE_CONTENT_BYTES {
            return Err(JiraMcpError::OutputTooLarge);
        }
        return Ok(text);
    }

    if let Some(structured) = result.get("structuredContent") {
        let text = structured
            .get("result")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .map_or_else(|| serde_json::to_string_pretty(structured), Ok)
            .map_err(|_| JiraMcpError::ProtocolInvalid)?;
        if text.len() > MAX_ISSUE_CONTENT_BYTES {
            return Err(JiraMcpError::OutputTooLarge);
        }
        return Ok(text);
    }

    Err(JiraMcpError::ProtocolInvalid)
}

fn extract_issue_fields(content: &str) -> (Option<String>, Option<String>) {
    let Ok(value) = serde_json::from_str::<Value>(content) else {
        return (None, None);
    };
    let summary =
        find_string(&value, &["fields", "summary"]).or_else(|| find_string(&value, &["summary"]));
    let status = find_string(&value, &["fields", "status", "name"])
        .or_else(|| find_string(&value, &["status", "name"]))
        .or_else(|| find_string(&value, &["status"]));
    (summary, status)
}

fn read_protocol_line(reader: &mut impl BufRead) -> Result<Option<Vec<u8>>, JiraMcpError> {
    let mut line = Vec::new();
    loop {
        let buffer = reader
            .fill_buf()
            .map_err(|_| JiraMcpError::ProtocolInvalid)?;
        if buffer.is_empty() {
            return if line.is_empty() {
                Ok(None)
            } else {
                Ok(Some(line))
            };
        }
        let newline = buffer.iter().position(|byte| *byte == b'\n');
        let take = newline.map_or(buffer.len(), |index| index + 1);
        if line.len().saturating_add(take) > MAX_MCP_MESSAGE_BYTES {
            return Err(JiraMcpError::OutputTooLarge);
        }
        line.extend_from_slice(&buffer[..take]);
        reader.consume(take);
        if newline.is_some() {
            return Ok(Some(line));
        }
    }
}

fn find_string(value: &Value, path: &[&str]) -> Option<String> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    current.as_str().map(ToOwned::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registration_allows_documented_mcp_atlassian_commands() {
        let registration = validate_registration(HostServer {
            command: Some("podman".to_owned()),
            args: vec![
                "run".to_owned(),
                "-i".to_owned(),
                "ghcr.io/sooperset/mcp-atlassian:latest".to_owned(),
            ],
            env: BTreeMap::new(),
            transport_type: Some("stdio".to_owned()),
        })
        .expect("registration");
        assert_eq!(registration.command, "podman");
    }

    #[test]
    fn container_registration_gets_an_installing_uvx_fallback_with_the_same_environment() {
        let registration = StdioRegistration {
            command: "/opt/homebrew/bin/podman".to_owned(),
            args: vec![
                "run".to_owned(),
                "--rm".to_owned(),
                "ghcr.io/sooperset/mcp-atlassian:latest".to_owned(),
            ],
            env: BTreeMap::from([("JIRA_URL".to_owned(), "https://jira.example".to_owned())]),
        };

        let fallback = uvx_fallback(&registration).expect("uvx fallback");

        assert_eq!(fallback.command, "uvx");
        assert_eq!(fallback.args, ["mcp-atlassian"]);
        assert_eq!(fallback.env, registration.env);
        assert!(uvx_fallback(&fallback).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn process_exit_before_the_first_response_is_a_startup_failure() {
        let registration = StdioRegistration {
            command: "sh".to_owned(),
            args: vec!["-c".to_owned(), "exit 7".to_owned()],
            env: BTreeMap::new(),
        };
        let mut client = McpClient::start(&registration).expect("child process");

        let _ = client.child.wait();

        assert_eq!(client.initialize(), Err(JiraMcpError::SpawnFailed));
    }

    #[test]
    fn issue_browser_url_uses_only_the_configured_jira_origin() {
        let registration = StdioRegistration {
            command: "mcp-atlassian".to_owned(),
            args: Vec::new(),
            env: BTreeMap::from([(
                "JIRA_URL".to_owned(),
                "https://jira.example.test".to_owned(),
            )]),
        };

        assert_eq!(
            configured_jira_issue_browser_url(&registration, "PLATFORM-42").as_deref(),
            Some("https://jira.example.test/browse/PLATFORM-42")
        );

        let untrusted = StdioRegistration {
            env: BTreeMap::from([(
                "JIRA_URL".to_owned(),
                "https://user@jira.example.test".to_owned(),
            )]),
            ..registration.clone()
        };
        assert!(configured_jira_issue_browser_url(&untrusted, "PLATFORM-42").is_none());

        let server_registration = StdioRegistration {
            env: BTreeMap::from([(
                "JIRA_URL".to_owned(),
                "https://jira.example/products/jira/".to_owned(),
            )]),
            ..registration
        };
        assert_eq!(
            configured_jira_issue_browser_url(&server_registration, "PLATFORM-42").as_deref(),
            Some("https://jira.example/products/jira/browse/PLATFORM-42")
        );
    }

    #[test]
    fn imported_issue_keeps_the_browser_origin_from_the_registration_that_succeeded() {
        let stale = StdioRegistration {
            command: "mcp-atlassian".to_owned(),
            args: Vec::new(),
            env: BTreeMap::from([("JIRA_URL".to_owned(), "https://jira-a.example".to_owned())]),
        };
        let active = StdioRegistration {
            env: BTreeMap::from([("JIRA_URL".to_owned(), "https://jira-b.example".to_owned())]),
            ..stale.clone()
        };
        let issue =
            jira_issue_from_registration(&active, "PLATFORM-42", "Summary: Safe link".to_owned());

        assert_eq!(
            issue.browser_url.as_deref(),
            Some("https://jira-b.example/browse/PLATFORM-42")
        );
        assert_eq!(
            trusted_configured_jira_issue_browser_url(
                &[stale, active],
                "PLATFORM-42",
                issue.browser_url.as_deref().expect("browser URL"),
            )
            .as_deref(),
            Some("https://jira-b.example/browse/PLATFORM-42")
        );
    }

    #[test]
    fn cloud_api_token_mislabeled_as_a_personal_token_uses_the_git_identity() {
        let mut env = BTreeMap::from([
            (
                "JIRA_URL".to_owned(),
                "https://jira.example.atlassian.net".to_owned(),
            ),
            (
                "JIRA_PERSONAL_TOKEN".to_owned(),
                "ATATT3x-cloud-api-token".to_owned(),
            ),
        ]);

        repair_cloud_api_token_environment(&mut env, Some("dev@example.com"));

        assert_eq!(
            env.get("JIRA_USERNAME").map(String::as_str),
            Some("dev@example.com")
        );
        assert_eq!(
            env.get("JIRA_API_TOKEN").map(String::as_str),
            Some("ATATT3x-cloud-api-token")
        );
        assert!(!env.contains_key("JIRA_PERSONAL_TOKEN"));
    }

    #[test]
    fn cloud_token_repair_does_not_override_explicit_credentials() {
        let mut env = BTreeMap::from([
            (
                "JIRA_URL".to_owned(),
                "https://jira.example.atlassian.net".to_owned(),
            ),
            ("JIRA_PERSONAL_TOKEN".to_owned(), "ATATT3x-token".to_owned()),
            ("JIRA_USERNAME".to_owned(), "owner@example.com".to_owned()),
        ]);

        repair_cloud_api_token_environment(&mut env, Some("git@example.com"));

        assert_eq!(
            env.get("JIRA_USERNAME").map(String::as_str),
            Some("owner@example.com")
        );
        assert!(!env.contains_key("JIRA_API_TOKEN"));
        assert!(env.contains_key("JIRA_PERSONAL_TOKEN"));
    }

    #[test]
    fn registration_rejects_shells_and_substitutions() {
        let error = validate_registration(HostServer {
            command: Some("sh".to_owned()),
            args: vec!["-c".to_owned(), "mcp-atlassian".to_owned()],
            env: BTreeMap::new(),
            transport_type: None,
        })
        .expect_err("shell must be rejected");
        assert_eq!(error, JiraMcpError::ConfigurationUnsupported);

        let error = validate_registration(HostServer {
            command: Some("uvx".to_owned()),
            args: vec!["mcp-atlassian".to_owned()],
            env: BTreeMap::from([("JIRA_API_TOKEN".to_owned(), "${input:token}".to_owned())]),
            transport_type: None,
        })
        .expect_err("substitution must be rejected");
        assert_eq!(error, JiraMcpError::ConfigurationUnsupported);
    }

    #[test]
    fn issue_keys_are_bounded_and_canonical() {
        assert_eq!(validate_issue_key("PLATFORM-42"), Ok("PLATFORM-42"));
        assert!(validate_issue_key("platform-42").is_err());
        assert!(validate_issue_key("PAY-x").is_err());
    }

    #[test]
    fn issue_tool_follows_serialized_mcp_pagination() {
        let pages = [
            json!({
                "tools": [{ "name": "confluence_search" }],
                "nextCursor": "jira-page"
            }),
            json!({
                "tools": [{ "name": "jira_get_issue" }]
            }),
        ];
        let mut requests = Vec::new();
        let mut page_index = 0;

        let tool = discover_tool("jira_get_issue", JiraMcpError::IssueToolMissing, |params| {
            requests.push(params);
            let page = pages
                .get(page_index)
                .cloned()
                .ok_or(JiraMcpError::ProtocolInvalid)?;
            page_index += 1;
            Ok(page)
        })
        .expect("tool on the second page");

        assert_eq!(tool, "jira_get_issue");
        assert_eq!(requests, vec![json!({}), json!({ "cursor": "jira-page" })]);
    }

    #[test]
    fn issue_tool_rejects_repeated_mcp_cursor() {
        let error = discover_tool("jira_get_issue", JiraMcpError::IssueToolMissing, |_| {
            Ok(json!({
                "tools": [{ "name": "confluence_search" }],
                "nextCursor": "same-page"
            }))
        })
        .expect_err("repeated cursors must not loop");

        assert_eq!(error, JiraMcpError::ProtocolInvalid);
    }

    #[test]
    fn active_issue_parser_accepts_cloud_and_server_shapes_without_descriptions() {
        let issues = extract_active_issues(
            r#"{
              "issues": [
                {
                  "key": "PLATFORM-42",
                  "fields": {
                    "summary": "Retry duplicate captures",
                    "status": {"name": "In Progress"},
                    "description": "must not cross the POC contract"
                  }
                },
                {
                  "issue_key": "OPS-41",
                  "summary": "Repair development environment",
                  "status": "Open"
                }
              ]
            }"#,
        )
        .expect("active issues");

        assert_eq!(
            issues,
            vec![
                JiraActiveIssue {
                    issue_key: "PLATFORM-42".to_owned(),
                    summary: "Retry duplicate captures".to_owned(),
                    status: "In Progress".to_owned(),
                },
                JiraActiveIssue {
                    issue_key: "OPS-41".to_owned(),
                    summary: "Repair development environment".to_owned(),
                    status: "Open".to_owned(),
                }
            ]
        );
        assert!(
            !serde_json::to_string(&issues)
                .unwrap()
                .contains("must not cross")
        );
    }

    #[test]
    fn imported_issue_extracts_description_from_the_serialized_mcp_result_and_keeps_raw_evidence() {
        let registration = StdioRegistration {
            command: "mcp-atlassian".to_owned(),
            args: Vec::new(),
            env: BTreeMap::from([("JIRA_URL".to_owned(), "https://jira.example".to_owned())]),
        };
        let description = "Keep all steps.\n\n1. Select the repository.\n2. Retain the draft 🧪.\n\n`{\"description\":\"example\"}`";
        for payload in [
            json!({ "key": "PLATFORM-42", "summary": "Retain draft", "status": "Open", "description": description }),
            json!({ "key": "PLATFORM-42", "fields": { "summary": "Retain draft", "status": { "name": "Open" }, "description": description } }),
        ] {
            let raw = payload.to_string();
            let response = json!({ "content": [{ "type": "text", "text": raw }] });
            let issue = jira_issue_from_registration(
                &registration,
                "PLATFORM-42",
                extract_tool_text(&response).expect("MCP text"),
            );
            assert_eq!(issue.description(), description);
            assert_eq!(issue.content, raw);
            assert_eq!(issue.summary.as_deref(), Some("Retain draft"));
            assert_eq!(issue.status.as_deref(), Some("Open"));
            let serialized = serde_json::to_value(&issue).expect("serialized issue");
            assert_eq!(serialized["content"], raw);
        }
    }

    #[test]
    fn issue_description_preserves_prose_unknown_json_and_mismatched_issue_keys() {
        for content in [
            "Read this code example: {\"description\":\"keep me\"}",
            r#"{"description":"user-owned JSON example"}"#,
            r#"{"key":"PLATFORM-42","summary":"No description field"}"#,
            r#"{"key":"OTHER-99","description":"another issue"}"#,
            r#"{"key":"PLATFORM-42","issue_key":"OTHER-99","description":"ambiguous issue"}"#,
            r#"{"key":"PLATFORM-42","description":{"custom":"unknown format"}}"#,
        ] {
            let issue = JiraIssue {
                issue_key: "PLATFORM-42".to_owned(),
                summary: None,
                status: None,
                content: content.to_owned(),
                browser_url: None,
            };
            assert_eq!(issue.description(), content);
        }
        for content in [
            r#"{"key":"PLATFORM-42","description":null}"#,
            r#"{"key":"PLATFORM-42","description":""}"#,
        ] {
            let issue = JiraIssue {
                issue_key: "PLATFORM-42".to_owned(),
                summary: None,
                status: None,
                content: content.to_owned(),
                browser_url: None,
            };
            assert_eq!(
                issue.description(),
                "No Jira description was available when this planning home was created."
            );
        }
    }

    #[test]
    fn tool_text_uses_the_serialized_text_result_instead_of_its_schema_wrapper() {
        let result = json!({
            "content": [{
                "type": "text",
                "text": "{\"issues\":[{\"key\":\"PLATFORM-42\"}]}"
            }],
            "structuredContent": {
                "result": "{\"issues\":[{\"key\":\"PLATFORM-42\"}]}"
            }
        });

        assert_eq!(
            extract_tool_text(&result),
            Ok("{\"issues\":[{\"key\":\"PLATFORM-42\"}]}".to_owned())
        );
    }
}
