use crate::process::{configure_process_group, terminate_process_group};
use hex::ToHex;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    env,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    net::IpAddr,
    path::{Component, Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    sync::mpsc::{self, Receiver, TryRecvError},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use thiserror::Error;
use uuid::Uuid;

pub const TEST_RUN_SCHEMA_VERSION: u32 = 1;

const WTS_DIRECTORY: &str = ".wts";
const TEST_RUNS_DIRECTORY: &str = "test-runs";
const MANIFEST_FILE: &str = "manifest.json";
const JOURNEY_FILE: &str = "journey.json";
const DRIVER_PLAN_FILE: &str = "driver-plan.json";
const DRIVER_OUTPUT_FILE: &str = "driver-result.json";
const RESULT_FILE: &str = "result.json";
const MAX_PLAN_BYTES: usize = 256 * 1024;
const MAX_RESULT_BYTES: usize = 1024 * 1024;
const MAX_PROCESS_STREAM_BYTES: usize = 128 * 1024;
const MAX_ARTIFACT_BYTES: u64 = 64 * 1024 * 1024;
const MAX_RUN_ARTIFACT_BYTES: u64 = 96 * 1024 * 1024;
// MVP retention is per materialized workspace. A later manager can enforce a
// cross-workspace ceiling without weakening these local safety bounds.
const MAX_RUNS: usize = 8;
const MAX_RETAINED_BYTES: u64 = 128 * 1024 * 1024;
const MAX_STEPS: usize = 64;
const MAX_SCREENSHOT_STEPS: usize = 16;
const MAX_ID_BYTES: usize = 128;
const MAX_TITLE_BYTES: usize = 256;
const MAX_ORIGIN_BYTES: usize = 512;
const MAX_PATH_BYTES: usize = 2_048;
const MAX_TARGET_BYTES: usize = 512;
const MAX_VALUE_BYTES: usize = 4_096;
const MAX_EVENT_TEXT_BYTES: usize = 2_048;
const MAX_ERROR_BYTES: usize = 4_096;
const MIN_RUN_TIMEOUT_MS: u64 = 1_000;
const MAX_RUN_TIMEOUT_MS: u64 = 300_000;
const MAX_STEP_TIMEOUT_MS: u64 = 15_000;
const MAX_DRIVER_STEP_RESULT_MS: u64 = (MAX_STEP_TIMEOUT_MS * 2) + 1_000;
const DRIVER_OUTPUT_GRACE_MS: u64 = 5_000;
const PROCESS_GRACE: Duration = Duration::from_secs(15);
const INTERRUPTED_RECONCILIATION_GRACE: Duration = Duration::from_secs(5);
const MAX_CONSOLE_ERRORS: usize = 100;
const MAX_REQUESTS: usize = 500;
const MAX_RECOVERY_SCAN_RUNS: usize = 64;
const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(20);

/// A closed, deterministic browser journey.
///
/// `graph_sha256` is WTS-owned context metadata. The process adapter deliberately
/// strips it, step identifiers, labels, and per-step timeouts from the private
/// helper plan so the helper receives only its exact allowlisted wire contract.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JourneyPlan {
    pub schema_version: u32,
    pub run_id: Uuid,
    pub workspace_id: Uuid,
    pub journey_id: String,
    pub title: String,
    pub base_url: String,
    pub allowed_origins: Vec<String>,
    pub timeout_ms: u64,
    pub steps: Vec<JourneyStep>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub graph_sha256: Option<String>,
}

impl JourneyPlan {
    pub fn new(
        run_id: Uuid,
        workspace_id: Uuid,
        journey_id: impl Into<String>,
        title: impl Into<String>,
        base_url: impl Into<String>,
        timeout_ms: u64,
        steps: Vec<JourneyStep>,
    ) -> Result<Self, JourneyPlanError> {
        let base_url = base_url.into();
        let plan = Self {
            schema_version: TEST_RUN_SCHEMA_VERSION,
            run_id,
            workspace_id,
            journey_id: journey_id.into(),
            title: title.into(),
            allowed_origins: vec![base_url.clone()],
            base_url,
            timeout_ms,
            steps,
            graph_sha256: None,
        };
        plan.validate()?;
        Ok(plan)
    }

    pub fn with_graph_sha256(
        mut self,
        graph_sha256: impl Into<String>,
    ) -> Result<Self, JourneyPlanError> {
        self.graph_sha256 = Some(graph_sha256.into());
        self.validate()?;
        Ok(self)
    }

    pub fn validate(&self) -> Result<(), JourneyPlanError> {
        if self.schema_version != TEST_RUN_SCHEMA_VERSION {
            return Err(JourneyPlanError::SchemaVersion);
        }
        validate_id(&self.journey_id)?;
        validate_text(&self.title, MAX_TITLE_BYTES, false)?;
        validate_loopback_origin(&self.base_url)?;
        if self.allowed_origins.len() != 1 || self.allowed_origins[0] != self.base_url {
            return Err(JourneyPlanError::AllowedOrigins);
        }
        if !(MIN_RUN_TIMEOUT_MS..=MAX_RUN_TIMEOUT_MS).contains(&self.timeout_ms) {
            return Err(JourneyPlanError::Timeout);
        }
        if self.steps.is_empty() || self.steps.len() > MAX_STEPS {
            return Err(JourneyPlanError::StepCount);
        }
        if self
            .graph_sha256
            .as_deref()
            .is_some_and(|digest| !valid_graph_sha256(digest))
        {
            return Err(JourneyPlanError::GraphDigest);
        }

        let mut identifiers = HashSet::with_capacity(self.steps.len());
        let mut screenshots = 0usize;
        for step in &self.steps {
            step.validate(&self.base_url)?;
            if !identifiers.insert(step.id.as_str()) {
                return Err(JourneyPlanError::DuplicateStepId);
            }
            if matches!(step.action, JourneyAction::Screenshot) {
                screenshots += 1;
            }
        }
        if screenshots > MAX_SCREENSHOT_STEPS {
            return Err(JourneyPlanError::ScreenshotCount);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JourneyStep {
    pub id: String,
    pub label: String,
    pub timeout_ms: u64,
    pub action: JourneyAction,
}

impl JourneyStep {
    pub fn new(
        id: impl Into<String>,
        label: impl Into<String>,
        timeout_ms: u64,
        action: JourneyAction,
    ) -> Result<Self, JourneyPlanError> {
        let step = Self {
            id: id.into(),
            label: label.into(),
            timeout_ms,
            action,
        };
        step.validate("http://127.0.0.1")?;
        Ok(step)
    }

    fn validate(&self, base_url: &str) -> Result<(), JourneyPlanError> {
        validate_id(&self.id)?;
        validate_text(&self.label, MAX_TITLE_BYTES, false)?;
        if self.timeout_ms == 0 || self.timeout_ms > MAX_STEP_TIMEOUT_MS {
            return Err(JourneyPlanError::StepTimeout);
        }
        self.action.validate(base_url)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum JourneyAction {
    Navigate {
        path: String,
    },
    Click {
        target: JourneyTarget,
    },
    Fill {
        target: JourneyTarget,
        value: String,
    },
    Select {
        target: JourneyTarget,
        value: String,
    },
    Check {
        target: JourneyTarget,
    },
    Press {
        target: JourneyTarget,
        key: JourneyKey,
    },
    AssertVisible {
        target: JourneyTarget,
    },
    AssertText {
        target: JourneyTarget,
        value: String,
        exact: bool,
    },
    AssertUrl {
        path: String,
    },
    Screenshot,
}

impl JourneyAction {
    fn validate(&self, base_url: &str) -> Result<(), JourneyPlanError> {
        match self {
            Self::Navigate { path } | Self::AssertUrl { path } => {
                validate_relative_path(path, base_url)
            }
            Self::Click { target }
            | Self::Check { target }
            | Self::AssertVisible { target }
            | Self::Press { target, .. } => target.validate(),
            Self::Fill { target, value } => {
                target.validate()?;
                validate_text(value, MAX_VALUE_BYTES, true)
            }
            Self::Select { target, value } | Self::AssertText { target, value, .. } => {
                target.validate()?;
                validate_text(value, MAX_VALUE_BYTES, false)
            }
            Self::Screenshot => Ok(()),
        }
    }

    fn kind(&self) -> JourneyStepKind {
        match self {
            Self::Navigate { .. } => JourneyStepKind::Navigate,
            Self::Click { .. } => JourneyStepKind::Click,
            Self::Fill { .. } => JourneyStepKind::Fill,
            Self::Select { .. } => JourneyStepKind::Select,
            Self::Check { .. } => JourneyStepKind::Check,
            Self::Press { .. } => JourneyStepKind::Press,
            Self::AssertVisible { .. } => JourneyStepKind::AssertVisible,
            Self::AssertText { .. } => JourneyStepKind::AssertText,
            Self::AssertUrl { .. } => JourneyStepKind::AssertUrl,
            Self::Screenshot => JourneyStepKind::Screenshot,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum JourneyTarget {
    Role {
        role: String,
        name: String,
        exact: bool,
    },
    Label {
        value: String,
        exact: bool,
    },
    Text {
        value: String,
        exact: bool,
    },
    TestId {
        value: String,
    },
}

impl JourneyTarget {
    pub fn role(
        role: impl Into<String>,
        name: impl Into<String>,
        exact: bool,
    ) -> Result<Self, JourneyPlanError> {
        let target = Self::Role {
            role: role.into(),
            name: name.into(),
            exact,
        };
        target.validate()?;
        Ok(target)
    }

    pub fn label(value: impl Into<String>, exact: bool) -> Result<Self, JourneyPlanError> {
        let target = Self::Label {
            value: value.into(),
            exact,
        };
        target.validate()?;
        Ok(target)
    }

    pub fn text(value: impl Into<String>, exact: bool) -> Result<Self, JourneyPlanError> {
        let target = Self::Text {
            value: value.into(),
            exact,
        };
        target.validate()?;
        Ok(target)
    }

    pub fn test_id(value: impl Into<String>) -> Result<Self, JourneyPlanError> {
        let target = Self::TestId {
            value: value.into(),
        };
        target.validate()?;
        Ok(target)
    }

    fn validate(&self) -> Result<(), JourneyPlanError> {
        match self {
            Self::Role { role, name, .. } => {
                if !ARIA_ROLES.contains(&role.as_str()) {
                    return Err(JourneyPlanError::Role);
                }
                validate_text(name, MAX_TARGET_BYTES, false)
            }
            Self::Label { value, .. } | Self::Text { value, .. } | Self::TestId { value } => {
                validate_text(value, MAX_TARGET_BYTES, false)
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub enum JourneyKey {
    Enter,
    Escape,
    Tab,
    Space,
    ArrowUp,
    ArrowDown,
    ArrowLeft,
    ArrowRight,
    Home,
    End,
    PageUp,
    PageDown,
    Backspace,
    Delete,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum JourneyStepKind {
    Navigate,
    Click,
    Fill,
    Select,
    Check,
    Press,
    AssertVisible,
    AssertText,
    AssertUrl,
    Screenshot,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TestRunState {
    Running,
    Passed,
    Failed,
    TimedOut,
    Cancelled,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TestStepState {
    Passed,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TestStepResult {
    pub step_id: String,
    pub label: String,
    pub kind: String,
    pub state: TestStepState,
    pub started_at_unix_ms: i64,
    pub completed_at_unix_ms: i64,
    pub duration_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot_artifact_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub screenshot_artifact_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConsoleErrorSummary {
    pub kind: String,
    pub text: String,
    pub timestamp_unix_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestSummary {
    pub method: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ArtifactKind {
    Trace,
    FailureScreenshot,
    StepSnapshot,
    Screenshot,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactMetadata {
    pub artifact_id: String,
    pub kind: ArtifactKind,
    pub relative_path: String,
    pub display_path: String,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FailureCapsule {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failed_step_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failed_step_kind: Option<String>,
    pub name: String,
    pub message: String,
    pub console_errors: Vec<ConsoleErrorSummary>,
    pub failed_requests: Vec<RequestSummary>,
    pub artifact_ids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TestRunResult {
    pub schema_version: u32,
    pub run_id: Uuid,
    pub workspace_id: Uuid,
    pub journey_id: String,
    pub state: TestRunState,
    pub started_at_unix_ms: i64,
    pub completed_at_unix_ms: i64,
    pub duration_ms: u64,
    pub steps: Vec<TestStepResult>,
    pub console_errors: Vec<ConsoleErrorSummary>,
    pub requests: Vec<RequestSummary>,
    pub artifacts: Vec<ArtifactMetadata>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure: Option<FailureCapsule>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub graph_sha256: Option<String>,
}

impl TestRunResult {
    pub fn summary(
        &self,
        title: impl Into<String>,
        artifacts_display_path: String,
        total_steps: usize,
    ) -> TestRunSummary {
        let passed_steps = self
            .steps
            .iter()
            .filter(|step| step.state == TestStepState::Passed)
            .count();
        let failed_steps = self.steps.len().saturating_sub(passed_steps);
        TestRunSummary {
            schema_version: TEST_RUN_SCHEMA_VERSION,
            run_id: self.run_id,
            workspace_id: self.workspace_id,
            journey_id: self.journey_id.clone(),
            title: title.into(),
            state: self.state,
            started_at_unix_ms: self.started_at_unix_ms,
            completed_at_unix_ms: Some(self.completed_at_unix_ms),
            duration_ms: Some(self.duration_ms),
            passed_steps,
            failed_steps,
            total_steps,
            failed_step_id: self
                .failure
                .as_ref()
                .and_then(|failure| failure.failed_step_id.clone()),
            message: self.failure.as_ref().map(|failure| failure.message.clone()),
            artifacts_display_path,
            graph_sha256: self.graph_sha256.clone(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TestRunSummary {
    pub schema_version: u32,
    pub run_id: Uuid,
    pub workspace_id: Uuid,
    pub journey_id: String,
    pub title: String,
    pub state: TestRunState,
    pub started_at_unix_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at_unix_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    pub passed_steps: usize,
    pub failed_steps: usize,
    pub total_steps: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failed_step_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub artifacts_display_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub graph_sha256: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TestRunList {
    pub schema_version: u32,
    pub workspace_id: Uuid,
    pub runs: Vec<TestRunSummary>,
}

impl TestRunList {
    pub fn new(workspace_id: Uuid, runs: Vec<TestRunSummary>) -> Self {
        Self {
            schema_version: TEST_RUN_SCHEMA_VERSION,
            workspace_id,
            runs,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TestRunManifest {
    pub schema_version: u32,
    pub summary: TestRunSummary,
    pub plan_sha256: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_sha256: Option<String>,
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum JourneyPlanError {
    #[error("journey schema version is unsupported")]
    SchemaVersion,
    #[error("journey identifier is invalid")]
    Identifier,
    #[error("journey text exceeds its bounded contract")]
    Text,
    #[error("journey base URL must be a canonical loopback http(s) origin")]
    BaseUrl,
    #[error("journey must authorize exactly its one base origin")]
    AllowedOrigins,
    #[error("journey timeout is outside the supported range")]
    Timeout,
    #[error("journey step count is outside the supported range")]
    StepCount,
    #[error("journey contains duplicate step identifiers")]
    DuplicateStepId,
    #[error("journey step timeout is outside the supported range")]
    StepTimeout,
    #[error("journey contains too many screenshot steps")]
    ScreenshotCount,
    #[error("journey path is not origin-relative")]
    RelativePath,
    #[error("journey ARIA role is not supported")]
    Role,
    #[error("graph digest must be lowercase SHA-256 hex")]
    GraphDigest,
}

const ARIA_ROLES: &[&str] = &[
    "alert",
    "alertdialog",
    "application",
    "article",
    "banner",
    "blockquote",
    "button",
    "caption",
    "cell",
    "checkbox",
    "code",
    "columnheader",
    "combobox",
    "complementary",
    "contentinfo",
    "definition",
    "deletion",
    "dialog",
    "directory",
    "document",
    "emphasis",
    "feed",
    "figure",
    "form",
    "generic",
    "grid",
    "gridcell",
    "group",
    "heading",
    "img",
    "insertion",
    "link",
    "list",
    "listbox",
    "listitem",
    "log",
    "main",
    "marquee",
    "math",
    "meter",
    "menu",
    "menubar",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "navigation",
    "none",
    "note",
    "option",
    "paragraph",
    "presentation",
    "progressbar",
    "radio",
    "radiogroup",
    "region",
    "row",
    "rowgroup",
    "rowheader",
    "scrollbar",
    "search",
    "searchbox",
    "separator",
    "slider",
    "spinbutton",
    "status",
    "strong",
    "subscript",
    "superscript",
    "switch",
    "tab",
    "table",
    "tablist",
    "tabpanel",
    "term",
    "textbox",
    "time",
    "timer",
    "toolbar",
    "tooltip",
    "tree",
    "treegrid",
    "treeitem",
];

fn validate_id(value: &str) -> Result<(), JourneyPlanError> {
    if value.is_empty()
        || value.len() > MAX_ID_BYTES
        || !value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'.' | b'_' | b'-'))
        })
    {
        return Err(JourneyPlanError::Identifier);
    }
    Ok(())
}

fn validate_text(
    value: &str,
    maximum_bytes: usize,
    allow_empty: bool,
) -> Result<(), JourneyPlanError> {
    if (!allow_empty && value.is_empty())
        || value.len() > maximum_bytes
        || value.contains('\0')
        || value
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    {
        return Err(JourneyPlanError::Text);
    }
    Ok(())
}

fn validate_loopback_origin(value: &str) -> Result<(), JourneyPlanError> {
    validate_text(value, MAX_ORIGIN_BYTES, false).map_err(|_| JourneyPlanError::BaseUrl)?;
    let (scheme, authority) = if let Some(authority) = value.strip_prefix("http://") {
        ("http", authority)
    } else if let Some(authority) = value.strip_prefix("https://") {
        ("https", authority)
    } else {
        return Err(JourneyPlanError::BaseUrl);
    };
    if authority.is_empty()
        || authority.contains('/')
        || authority.contains('?')
        || authority.contains('#')
        || authority.contains('@')
        || authority.chars().any(char::is_whitespace)
    {
        return Err(JourneyPlanError::BaseUrl);
    }

    let (host, port) = if let Some(bracketed) = authority.strip_prefix('[') {
        let closing = bracketed.find(']').ok_or(JourneyPlanError::BaseUrl)?;
        let host = &bracketed[..closing];
        let suffix = &bracketed[closing + 1..];
        let port = validate_optional_port(suffix)?;
        (host, port)
    } else {
        let (host, port) = match authority.rsplit_once(':') {
            Some((host, port)) if !host.contains(':') => (host, Some(port)),
            Some(_) => return Err(JourneyPlanError::BaseUrl),
            None => (authority, None),
        };
        if let Some(port) = port {
            validate_port(port)?;
        }
        (host, port)
    };

    let loopback = host == "localhost"
        || host.parse::<IpAddr>().is_ok_and(|address| {
            address.is_loopback()
                && match address {
                    IpAddr::V4(address) => address.to_string() == host,
                    IpAddr::V6(address) => {
                        address == std::net::Ipv6Addr::LOCALHOST && host == "::1"
                    }
                }
        });
    if !loopback {
        return Err(JourneyPlanError::BaseUrl);
    }
    if port.is_some_and(|port| {
        (scheme == "http" && port == "80") || (scheme == "https" && port == "443")
    }) {
        return Err(JourneyPlanError::BaseUrl);
    }
    Ok(())
}

fn validate_optional_port(suffix: &str) -> Result<Option<&str>, JourneyPlanError> {
    if suffix.is_empty() {
        return Ok(None);
    }
    let port = suffix.strip_prefix(':').ok_or(JourneyPlanError::BaseUrl)?;
    validate_port(port)?;
    Ok(Some(port))
}

fn validate_port(port: &str) -> Result<(), JourneyPlanError> {
    if port.is_empty()
        || (port.len() > 1 && port.starts_with('0'))
        || !port.bytes().all(|byte| byte.is_ascii_digit())
        || port.parse::<u16>().ok().filter(|port| *port > 0).is_none()
    {
        return Err(JourneyPlanError::BaseUrl);
    }
    Ok(())
}

fn validate_relative_path(value: &str, base_url: &str) -> Result<(), JourneyPlanError> {
    validate_text(value, MAX_PATH_BYTES, false).map_err(|_| JourneyPlanError::RelativePath)?;
    if !value.starts_with('/')
        || value.starts_with("//")
        || value.contains('\\')
        || value.contains('\r')
        || value.contains('\n')
        || value.contains('\0')
        || value.contains("://")
        || !matches!(base_url.split_once("://"), Some(("http" | "https", _)))
    {
        return Err(JourneyPlanError::RelativePath);
    }
    Ok(())
}

fn valid_graph_sha256(value: &str) -> bool {
    valid_lower_sha256_hex(value)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TestArtifactRetention {
    maximum_runs: usize,
    maximum_bytes: u64,
}

impl TestArtifactRetention {
    pub fn new(maximum_runs: usize, maximum_bytes: u64) -> Result<Self, TestArtifactStoreError> {
        if maximum_runs == 0 || maximum_bytes == 0 {
            return Err(TestArtifactStoreError::InvalidRetention);
        }
        Ok(Self {
            maximum_runs,
            maximum_bytes,
        })
    }

    pub fn maximum_runs(self) -> usize {
        self.maximum_runs
    }

    pub fn maximum_bytes(self) -> u64 {
        self.maximum_bytes
    }
}

impl Default for TestArtifactRetention {
    fn default() -> Self {
        Self {
            maximum_runs: MAX_RUNS,
            maximum_bytes: MAX_RETAINED_BYTES,
        }
    }
}

#[derive(Clone, Debug)]
pub struct TestArtifactStore {
    workspace_root: PathBuf,
    root: PathBuf,
    retention: TestArtifactRetention,
}

impl TestArtifactStore {
    pub(crate) fn relocate_workspace_paths(
        current_workspace_root: &Path,
        previous_workspace_root: &Path,
    ) -> Result<(), TestArtifactStoreError> {
        let runs = current_workspace_root
            .join(WTS_DIRECTORY)
            .join(TEST_RUNS_DIRECTORY);
        match runs.symlink_metadata() {
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(map_store_io_error(error)),
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Ok(_) => return Err(TestArtifactStoreError::InvalidPath),
        }
        Self::open(current_workspace_root)?.relocate_paths(previous_workspace_root)
    }

    /// Opens or creates `.wts/test-runs` beneath an already canonical workspace.
    ///
    /// Every path component owned by this store must be a real directory, not a
    /// symlink. The canonical-path requirement avoids silently accepting an
    /// alias whose trust boundary differs from the materialized workspace root.
    pub fn open(workspace_root: &Path) -> Result<Self, TestArtifactStoreError> {
        Self::open_with_retention(workspace_root, TestArtifactRetention::default())
    }

    pub fn open_with_retention(
        workspace_root: &Path,
        retention: TestArtifactRetention,
    ) -> Result<Self, TestArtifactStoreError> {
        validate_retention(retention)?;
        if !workspace_root.is_absolute() {
            return Err(TestArtifactStoreError::InvalidWorkspace);
        }
        let metadata = workspace_root
            .symlink_metadata()
            .map_err(map_store_io_error)?;
        let canonical = workspace_root.canonicalize().map_err(map_store_io_error)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() || canonical != workspace_root {
            return Err(TestArtifactStoreError::InvalidWorkspace);
        }

        let wts_root = canonical.join(WTS_DIRECTORY);
        create_direct_directory(&canonical, &wts_root, WTS_DIRECTORY)?;
        let root = wts_root.join(TEST_RUNS_DIRECTORY);
        create_direct_directory(&wts_root, &root, TEST_RUNS_DIRECTORY)?;
        let store = Self {
            workspace_root: canonical,
            root,
            retention,
        };
        store.validate_roots()?;
        Ok(store)
    }

    pub fn workspace_root(&self) -> &Path {
        &self.workspace_root
    }

    pub fn artifacts_root(&self) -> &Path {
        &self.root
    }

    pub(crate) fn relocate_paths(
        &self,
        previous_workspace_root: &Path,
    ) -> Result<(), TestArtifactStoreError> {
        if !previous_workspace_root.is_absolute() || previous_workspace_root == self.workspace_root
        {
            return Err(TestArtifactStoreError::InvalidWorkspace);
        }
        self.validate_roots()?;
        let previous_runs = previous_workspace_root
            .join(WTS_DIRECTORY)
            .join(TEST_RUNS_DIRECTORY);
        let mut entries = fs::read_dir(&self.root)
            .map_err(map_store_io_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(map_store_io_error)?;
        entries.sort_by_key(|entry| entry.file_name());
        if entries.len() > self.retention.maximum_runs {
            return Err(TestArtifactStoreError::InvalidData);
        }
        for entry in entries {
            let run_id = entry
                .file_name()
                .to_str()
                .ok_or(TestArtifactStoreError::InvalidPath)
                .and_then(|leaf| {
                    Uuid::parse_str(leaf).map_err(|_| TestArtifactStoreError::InvalidPath)
                })?;
            let run_dir = entry.path();
            validate_run_directory(&self.root, &run_dir, run_id)?;
            let previous_run_dir = previous_runs.join(run_id.to_string());
            let mut manifest: TestRunManifest =
                read_json_file(&run_dir, MANIFEST_FILE, MAX_RESULT_BYTES)?;
            if Path::new(&manifest.summary.artifacts_display_path) != previous_run_dir {
                return Err(TestArtifactStoreError::InvalidData);
            }
            manifest.summary.artifacts_display_path = path_to_display(&run_dir)?;

            let result_path = run_dir.join(RESULT_FILE);
            match result_path.symlink_metadata() {
                Ok(_) => {
                    let mut result: TestRunResult =
                        read_json_file(&run_dir, RESULT_FILE, MAX_RESULT_BYTES)?;
                    for artifact in &mut result.artifacts {
                        let expected_previous = previous_run_dir.join(&artifact.relative_path);
                        if Path::new(&artifact.display_path) != expected_previous {
                            return Err(TestArtifactStoreError::InvalidArtifact);
                        }
                        artifact.display_path =
                            path_to_display(&run_dir.join(&artifact.relative_path))?;
                    }
                    let result_bytes = serde_json::to_vec_pretty(&result)
                        .map_err(|_| TestArtifactStoreError::InvalidData)?;
                    atomic_replace_bytes(&run_dir, RESULT_FILE, &result_bytes, MAX_RESULT_BYTES)?;
                    manifest.result_sha256 = Some(sha256_bytes(&result_bytes));
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    if manifest.result_sha256.is_some() {
                        return Err(TestArtifactStoreError::InvalidData);
                    }
                }
                Err(error) => return Err(map_store_io_error(error)),
            }
            atomic_replace_json(&run_dir, MANIFEST_FILE, &manifest, MAX_RESULT_BYTES)?;
            read_run_record(&run_dir, run_id, true)?;
        }
        Ok(())
    }

    pub fn begin(&self, plan: &JourneyPlan) -> Result<TestRunManifest, TestArtifactStoreError> {
        plan.validate()
            .map_err(|_| TestArtifactStoreError::InvalidPlan)?;
        self.validate_roots()?;
        let run_dir = self.root.join(plan.run_id.to_string());
        match fs::create_dir(&run_dir) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                return Err(TestArtifactStoreError::AlreadyExists);
            }
            Err(error) => return Err(map_store_io_error(error)),
        }
        if let Err(error) = validate_run_directory(&self.root, &run_dir, plan.run_id) {
            let _ = fs::remove_dir(&run_dir);
            return Err(error);
        }

        let outcome = (|| {
            let plan_bytes =
                serde_json::to_vec_pretty(plan).map_err(|_| TestArtifactStoreError::InvalidData)?;
            atomic_replace_bytes(&run_dir, JOURNEY_FILE, &plan_bytes, MAX_PLAN_BYTES)?;
            let started_at_unix_ms = unix_ms_now();
            let artifacts_display_path = path_to_display(&run_dir)?;
            let summary = TestRunSummary {
                schema_version: TEST_RUN_SCHEMA_VERSION,
                run_id: plan.run_id,
                workspace_id: plan.workspace_id,
                journey_id: plan.journey_id.clone(),
                title: plan.title.clone(),
                state: TestRunState::Running,
                started_at_unix_ms,
                completed_at_unix_ms: None,
                duration_ms: None,
                passed_steps: 0,
                failed_steps: 0,
                total_steps: plan.steps.len(),
                failed_step_id: None,
                message: None,
                artifacts_display_path,
                graph_sha256: plan.graph_sha256.clone(),
            };
            let manifest = TestRunManifest {
                schema_version: TEST_RUN_SCHEMA_VERSION,
                summary,
                plan_sha256: sha256_bytes(&plan_bytes),
                result_sha256: None,
            };
            atomic_replace_json(&run_dir, MANIFEST_FILE, &manifest, MAX_RESULT_BYTES)?;
            self.enforce_retention_protecting(Some(plan.run_id))?;
            Ok(manifest)
        })();
        if outcome.is_err() {
            let _ = remove_tree_safely(&self.root, &run_dir);
        }
        outcome
    }

    pub fn write_result(&self, result: &TestRunResult) -> Result<(), TestArtifactStoreError> {
        validate_result_identity(result)?;
        let run_dir = self.require_run_directory(result.run_id)?;
        let record = read_run_record(&run_dir, result.run_id, true)?;
        validate_result_against_plan(&run_dir, result, &record.plan, true)?;
        let manifest = record.manifest;
        if manifest.summary.run_id != result.run_id
            || manifest.summary.workspace_id != result.workspace_id
            || manifest.summary.journey_id != result.journey_id
            || manifest.summary.graph_sha256 != result.graph_sha256
        {
            return Err(TestArtifactStoreError::InvalidData);
        }
        atomic_replace_json(&run_dir, RESULT_FILE, result, MAX_RESULT_BYTES)
    }

    pub fn finalize(
        &self,
        result: &TestRunResult,
    ) -> Result<TestRunManifest, TestArtifactStoreError> {
        if result.state == TestRunState::Running {
            return Err(TestArtifactStoreError::InvalidData);
        }
        let run_dir = self.require_run_directory(result.run_id)?;
        let mut manifest = read_run_record(&run_dir, result.run_id, true)?.manifest;
        self.write_result(result)?;
        manifest.summary = result.summary(
            manifest.summary.title.clone(),
            path_to_display(&run_dir)?,
            manifest.summary.total_steps,
        );
        manifest.result_sha256 = Some(sha256_file(
            &run_dir.join(RESULT_FILE),
            MAX_RESULT_BYTES as u64,
        )?);
        atomic_replace_json(&run_dir, MANIFEST_FILE, &manifest, MAX_RESULT_BYTES)?;
        self.enforce_retention_protecting(Some(result.run_id))?;
        Ok(manifest)
    }

    pub fn list(&self) -> Result<Vec<TestRunSummary>, TestArtifactStoreError> {
        self.validate_roots()?;
        let mut summaries = Vec::new();
        for entry in fs::read_dir(&self.root).map_err(map_store_io_error)? {
            let entry = entry.map_err(map_store_io_error)?;
            let leaf = entry
                .file_name()
                .to_str()
                .ok_or(TestArtifactStoreError::InvalidPath)?
                .to_owned();
            let run_id = Uuid::parse_str(&leaf).map_err(|_| TestArtifactStoreError::InvalidPath)?;
            let run_dir = self.root.join(&leaf);
            validate_run_directory(&self.root, &run_dir, run_id)?;
            summaries.push(read_run_record(&run_dir, run_id, false)?.manifest.summary);
        }
        summaries.sort_by(|left, right| {
            summary_recency(right)
                .cmp(&summary_recency(left))
                .then_with(|| right.run_id.cmp(&left.run_id))
        });
        Ok(summaries)
    }

    pub fn read_manifest(
        &self,
        run_id: Uuid,
    ) -> Result<Option<TestRunManifest>, TestArtifactStoreError> {
        let Some(run_dir) = self.optional_run_directory(run_id)? else {
            return Ok(None);
        };
        Ok(Some(read_run_record(&run_dir, run_id, false)?.manifest))
    }

    pub fn read(&self, run_id: Uuid) -> Result<Option<TestRunResult>, TestArtifactStoreError> {
        let Some(run_dir) = self.optional_run_directory(run_id)? else {
            return Ok(None);
        };
        Ok(read_run_record(&run_dir, run_id, true)?.result)
    }

    pub fn run_directory(&self, run_id: Uuid) -> Result<Option<PathBuf>, TestArtifactStoreError> {
        self.optional_run_directory(run_id)
    }

    pub fn enforce_retention(&self) -> Result<(), TestArtifactStoreError> {
        self.enforce_retention_protecting(None)
    }

    /// Marks runs abandoned by a previous WTS process as interrupted.
    ///
    /// Call this only while holding the selected workspace's browser-run lock.
    /// The scan is deliberately bounded and never walks other workspaces.
    pub fn recover_interrupted(&self) -> Result<Vec<TestRunSummary>, TestArtifactStoreError> {
        self.validate_roots()?;
        let entries = fs::read_dir(&self.root)
            .map_err(map_store_io_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(map_store_io_error)?;
        if entries.len() > MAX_RECOVERY_SCAN_RUNS {
            return Err(TestArtifactStoreError::RetentionExceeded);
        }
        let now_unix_ms = unix_ms_now();
        let mut interrupted = Vec::new();
        for entry in entries {
            let leaf = entry
                .file_name()
                .to_str()
                .ok_or(TestArtifactStoreError::InvalidPath)?
                .to_owned();
            let run_id = Uuid::parse_str(&leaf).map_err(|_| TestArtifactStoreError::InvalidPath)?;
            let run_dir = self.root.join(leaf);
            validate_run_directory(&self.root, &run_dir, run_id)?;
            let record = read_run_record(&run_dir, run_id, false)?;
            let stale_after_ms = record
                .plan
                .timeout_ms
                .saturating_add(u64::try_from(PROCESS_GRACE.as_millis()).unwrap_or(u64::MAX))
                .saturating_add(
                    u64::try_from(INTERRUPTED_RECONCILIATION_GRACE.as_millis()).unwrap_or(u64::MAX),
                );
            if record.manifest.summary.state == TestRunState::Running
                && u64::try_from(
                    now_unix_ms.saturating_sub(record.manifest.summary.started_at_unix_ms),
                )
                .is_ok_and(|age_ms| age_ms >= stale_after_ms)
            {
                interrupted.push((record.plan, record.manifest));
            }
        }
        interrupted.sort_by(|left, right| {
            left.1
                .summary
                .started_at_unix_ms
                .cmp(&right.1.summary.started_at_unix_ms)
                .then_with(|| left.0.run_id.cmp(&right.0.run_id))
        });

        let mut recovered = Vec::with_capacity(interrupted.len());
        for (plan, manifest) in interrupted {
            let completed_at_unix_ms = now_unix_ms.max(manifest.summary.started_at_unix_ms);
            let result = TestRunResult {
                schema_version: TEST_RUN_SCHEMA_VERSION,
                run_id: plan.run_id,
                workspace_id: plan.workspace_id,
                journey_id: plan.journey_id.clone(),
                state: TestRunState::Cancelled,
                started_at_unix_ms: manifest.summary.started_at_unix_ms,
                completed_at_unix_ms,
                duration_ms: elapsed_between(
                    manifest.summary.started_at_unix_ms,
                    completed_at_unix_ms,
                )
                .unwrap_or(u64::MAX),
                steps: Vec::new(),
                console_errors: Vec::new(),
                requests: Vec::new(),
                artifacts: Vec::new(),
                failure: Some(FailureCapsule {
                    failed_step_id: None,
                    failed_step_kind: None,
                    name: "interrupted".to_owned(),
                    message: "WTS restarted before this local browser journey completed."
                        .to_owned(),
                    console_errors: Vec::new(),
                    failed_requests: Vec::new(),
                    artifact_ids: Vec::new(),
                }),
                graph_sha256: plan.graph_sha256.clone(),
            };
            recovered.push(self.finalize(&result)?.summary);
        }
        recovered.sort_by(|left, right| {
            summary_recency(right)
                .cmp(&summary_recency(left))
                .then_with(|| right.run_id.cmp(&left.run_id))
        });
        Ok(recovered)
    }

    fn validate_roots(&self) -> Result<(), TestArtifactStoreError> {
        validate_direct_directory(
            &self.workspace_root,
            &self.workspace_root.join(WTS_DIRECTORY),
            WTS_DIRECTORY,
        )?;
        validate_direct_directory(
            &self.workspace_root.join(WTS_DIRECTORY),
            &self.root,
            TEST_RUNS_DIRECTORY,
        )
    }

    fn require_run_directory(&self, run_id: Uuid) -> Result<PathBuf, TestArtifactStoreError> {
        self.optional_run_directory(run_id)?
            .ok_or(TestArtifactStoreError::NotFound)
    }

    fn optional_run_directory(
        &self,
        run_id: Uuid,
    ) -> Result<Option<PathBuf>, TestArtifactStoreError> {
        self.validate_roots()?;
        let run_dir = self.root.join(run_id.to_string());
        match run_dir.symlink_metadata() {
            Ok(_) => {
                validate_run_directory(&self.root, &run_dir, run_id)?;
                Ok(Some(run_dir))
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(map_store_io_error(error)),
        }
    }

    fn enforce_retention_protecting(
        &self,
        protected_run_id: Option<Uuid>,
    ) -> Result<(), TestArtifactStoreError> {
        self.validate_roots()?;
        let mut runs = Vec::new();
        for entry in fs::read_dir(&self.root).map_err(map_store_io_error)? {
            let entry = entry.map_err(map_store_io_error)?;
            let leaf = entry
                .file_name()
                .to_str()
                .ok_or(TestArtifactStoreError::InvalidPath)?
                .to_owned();
            let run_id = Uuid::parse_str(&leaf).map_err(|_| TestArtifactStoreError::InvalidPath)?;
            let run_dir = self.root.join(&leaf);
            validate_run_directory(&self.root, &run_dir, run_id)?;
            let manifest = read_run_record(&run_dir, run_id, false)?.manifest;
            let bytes = directory_size_safely(&run_dir)?;
            runs.push(StoredTestRun {
                run_id,
                path: run_dir,
                recency: summary_recency(&manifest.summary),
                bytes,
            });
        }
        runs.sort_by(|left, right| {
            (Some(right.run_id) == protected_run_id)
                .cmp(&(Some(left.run_id) == protected_run_id))
                .then_with(|| right.recency.cmp(&left.recency))
                .then_with(|| right.run_id.cmp(&left.run_id))
        });

        let mut retained_bytes = 0u64;
        let mut split = 0usize;
        for (retained_count, run) in runs.iter().enumerate() {
            let next_bytes = retained_bytes
                .checked_add(run.bytes)
                .ok_or(TestArtifactStoreError::RetentionExceeded)?;
            if retained_count == self.retention.maximum_runs
                || next_bytes > self.retention.maximum_bytes
            {
                if Some(run.run_id) == protected_run_id {
                    return Err(TestArtifactStoreError::RetentionExceeded);
                }
                break;
            }
            retained_bytes = next_bytes;
            split = retained_count + 1;
        }
        for run in runs.into_iter().skip(split) {
            if Some(run.run_id) == protected_run_id {
                return Err(TestArtifactStoreError::RetentionExceeded);
            }
            remove_tree_safely(&self.root, &run.path)?;
        }
        let _ = File::open(&self.root).and_then(|directory| directory.sync_all());
        Ok(())
    }

    fn write_driver_plan(
        &self,
        plan: &JourneyPlan,
    ) -> Result<ProcessRunPaths, TestArtifactStoreError> {
        let run_dir = self.require_run_directory(plan.run_id)?;
        let driver_plan = DriverJourneyPlan::from(plan);
        atomic_replace_json(&run_dir, DRIVER_PLAN_FILE, &driver_plan, MAX_PLAN_BYTES)?;
        let plan_path = require_direct_file(&run_dir, DRIVER_PLAN_FILE, MAX_PLAN_BYTES)?;
        let artifacts_dir = run_dir.canonicalize().map_err(map_store_io_error)?;
        if artifacts_dir != run_dir {
            return Err(TestArtifactStoreError::InvalidPath);
        }
        let output_path = run_dir.join(DRIVER_OUTPUT_FILE);
        match output_path.symlink_metadata() {
            Ok(_) => return Err(TestArtifactStoreError::InvalidPath),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(map_store_io_error(error)),
        }
        OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&output_path)
            .and_then(|file| file.sync_all())
            .map_err(map_store_io_error)?;
        let output_path = output_path.canonicalize().map_err(map_store_io_error)?;
        Ok(ProcessRunPaths {
            run_dir,
            plan_path,
            artifacts_dir,
            output_path,
        })
    }

    fn read_driver_output(
        &self,
        paths: &ProcessRunPaths,
    ) -> Result<DriverOutput, TestArtifactStoreError> {
        validate_run_directory(&self.root, &paths.run_dir, {
            let leaf = paths
                .run_dir
                .file_name()
                .and_then(|leaf| leaf.to_str())
                .ok_or(TestArtifactStoreError::InvalidPath)?;
            Uuid::parse_str(leaf).map_err(|_| TestArtifactStoreError::InvalidPath)?
        })?;
        read_json_file(&paths.run_dir, DRIVER_OUTPUT_FILE, MAX_RESULT_BYTES)
    }

    fn collect_artifacts(
        &self,
        run_id: Uuid,
        output: &DriverArtifacts,
    ) -> Result<Vec<ArtifactMetadata>, TestArtifactStoreError> {
        let run_dir = self.require_run_directory(run_id)?;
        let mut candidates = Vec::new();
        if let Some(path) = &output.trace {
            candidates.push((ArtifactKind::Trace, path.as_str()));
        }
        if let Some(path) = &output.failure_screenshot {
            candidates.push((ArtifactKind::FailureScreenshot, path.as_str()));
        }
        candidates.extend(
            output
                .step_snapshots
                .iter()
                .map(|path| (ArtifactKind::StepSnapshot, path.as_str())),
        );
        candidates.extend(
            output
                .screenshots
                .iter()
                .map(|path| (ArtifactKind::Screenshot, path.as_str())),
        );
        let mut seen = HashSet::with_capacity(candidates.len());
        let mut total_bytes = 0u64;
        let mut artifacts = Vec::with_capacity(candidates.len());
        for (index, (kind, relative)) in candidates.into_iter().enumerate() {
            if !seen.insert(relative.to_owned()) {
                return Err(TestArtifactStoreError::InvalidArtifact);
            }
            let path = safe_artifact_file(&run_dir, relative)?;
            let metadata = path.symlink_metadata().map_err(map_store_io_error)?;
            if !metadata.is_file()
                || metadata.file_type().is_symlink()
                || metadata.len() > MAX_ARTIFACT_BYTES
            {
                return Err(TestArtifactStoreError::InvalidArtifact);
            }
            total_bytes = total_bytes
                .checked_add(metadata.len())
                .ok_or(TestArtifactStoreError::ArtifactLimitExceeded)?;
            if total_bytes > MAX_RUN_ARTIFACT_BYTES {
                return Err(TestArtifactStoreError::ArtifactLimitExceeded);
            }
            artifacts.push(ArtifactMetadata {
                artifact_id: format!("artifact-{index:03}"),
                kind,
                relative_path: relative.to_owned(),
                display_path: path_to_display(&path)?,
                bytes: metadata.len(),
                sha256: sha256_file(&path, MAX_ARTIFACT_BYTES)?,
            });
        }
        Ok(artifacts)
    }
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum TestArtifactStoreError {
    #[error("test artifact workspace root must already be canonical")]
    InvalidWorkspace,
    #[error("test artifact path is invalid or unsafe")]
    InvalidPath,
    #[error("test artifact storage is unavailable")]
    Unavailable,
    #[error("test run already exists")]
    AlreadyExists,
    #[error("test run was not found")]
    NotFound,
    #[error("test journey plan is invalid")]
    InvalidPlan,
    #[error("test artifact data is invalid")]
    InvalidData,
    #[error("test artifact reference is invalid")]
    InvalidArtifact,
    #[error("test artifact exceeds its size limit")]
    ArtifactLimitExceeded,
    #[error("test artifact retention settings are invalid")]
    InvalidRetention,
    #[error("the protected run cannot fit within artifact retention")]
    RetentionExceeded,
}

struct StoredTestRun {
    run_id: Uuid,
    path: PathBuf,
    recency: i64,
    bytes: u64,
}

struct StoredRunRecord {
    manifest: TestRunManifest,
    plan: JourneyPlan,
    result: Option<TestRunResult>,
}

struct ProcessRunPaths {
    run_dir: PathBuf,
    plan_path: PathBuf,
    artifacts_dir: PathBuf,
    output_path: PathBuf,
}

fn validate_retention(retention: TestArtifactRetention) -> Result<(), TestArtifactStoreError> {
    if retention.maximum_runs == 0 || retention.maximum_bytes == 0 {
        return Err(TestArtifactStoreError::InvalidRetention);
    }
    Ok(())
}

fn create_direct_directory(
    parent: &Path,
    candidate: &Path,
    expected_leaf: &str,
) -> Result<(), TestArtifactStoreError> {
    if candidate.parent() != Some(parent)
        || candidate.file_name().and_then(|leaf| leaf.to_str()) != Some(expected_leaf)
    {
        return Err(TestArtifactStoreError::InvalidPath);
    }
    match candidate.symlink_metadata() {
        Ok(_) => validate_direct_directory(parent, candidate, expected_leaf),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            fs::create_dir(candidate).map_err(map_store_io_error)?;
            validate_direct_directory(parent, candidate, expected_leaf)
        }
        Err(error) => Err(map_store_io_error(error)),
    }
}

fn validate_direct_directory(
    parent: &Path,
    candidate: &Path,
    expected_leaf: &str,
) -> Result<(), TestArtifactStoreError> {
    if candidate.parent() != Some(parent)
        || candidate.file_name().and_then(|leaf| leaf.to_str()) != Some(expected_leaf)
    {
        return Err(TestArtifactStoreError::InvalidPath);
    }
    let metadata = candidate.symlink_metadata().map_err(map_store_io_error)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(TestArtifactStoreError::InvalidPath);
    }
    let canonical = candidate.canonicalize().map_err(map_store_io_error)?;
    if canonical != candidate {
        return Err(TestArtifactStoreError::InvalidPath);
    }
    Ok(())
}

fn validate_run_directory(
    root: &Path,
    run_dir: &Path,
    run_id: Uuid,
) -> Result<(), TestArtifactStoreError> {
    if run_dir.parent() != Some(root)
        || run_dir.file_name().and_then(|leaf| leaf.to_str()) != Some(run_id.to_string().as_str())
    {
        return Err(TestArtifactStoreError::InvalidPath);
    }
    let metadata = run_dir.symlink_metadata().map_err(map_store_io_error)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(TestArtifactStoreError::InvalidPath);
    }
    let canonical = run_dir.canonicalize().map_err(map_store_io_error)?;
    if canonical != run_dir {
        return Err(TestArtifactStoreError::InvalidPath);
    }
    Ok(())
}

fn validate_manifest(
    manifest: &TestRunManifest,
    run_id: Uuid,
    run_dir: &Path,
) -> Result<(), TestArtifactStoreError> {
    if manifest.schema_version != TEST_RUN_SCHEMA_VERSION
        || manifest.summary.schema_version != TEST_RUN_SCHEMA_VERSION
        || manifest.summary.run_id != run_id
        || manifest.summary.artifacts_display_path != path_to_display(run_dir)?
        || !valid_sha256(&manifest.plan_sha256)
        || manifest
            .result_sha256
            .as_deref()
            .is_some_and(|digest| !valid_sha256(digest))
        || manifest
            .summary
            .graph_sha256
            .as_deref()
            .is_some_and(|digest| !valid_graph_sha256(digest))
    {
        return Err(TestArtifactStoreError::InvalidData);
    }
    Ok(())
}

fn validate_result_identity(result: &TestRunResult) -> Result<(), TestArtifactStoreError> {
    if result.schema_version != TEST_RUN_SCHEMA_VERSION
        || result.state == TestRunState::Running
        || result.completed_at_unix_ms < result.started_at_unix_ms
        || result
            .graph_sha256
            .as_deref()
            .is_some_and(|digest| !valid_graph_sha256(digest))
    {
        return Err(TestArtifactStoreError::InvalidData);
    }
    Ok(())
}

fn validate_result_artifacts(
    run_dir: &Path,
    result: &TestRunResult,
    verify_hashes: bool,
) -> Result<(), TestArtifactStoreError> {
    if result.artifacts.len() > 2 + MAX_STEPS + MAX_SCREENSHOT_STEPS {
        return Err(TestArtifactStoreError::ArtifactLimitExceeded);
    }
    let mut identifiers = HashSet::with_capacity(result.artifacts.len());
    let mut relative_paths = HashSet::with_capacity(result.artifacts.len());
    let mut total_bytes = 0u64;
    let mut traces = 0usize;
    let mut failure_screenshots = 0usize;
    let mut step_snapshots = 0usize;
    let mut screenshots = 0usize;
    for artifact in &result.artifacts {
        validate_id(&artifact.artifact_id).map_err(|_| TestArtifactStoreError::InvalidData)?;
        if !identifiers.insert(artifact.artifact_id.as_str())
            || !relative_paths.insert(artifact.relative_path.as_str())
            || !valid_sha256(&artifact.sha256)
        {
            return Err(TestArtifactStoreError::InvalidData);
        }
        let path = safe_artifact_file(run_dir, &artifact.relative_path)?;
        let metadata = path.symlink_metadata().map_err(map_store_io_error)?;
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata.len() != artifact.bytes
            || path_to_display(&path)? != artifact.display_path
            || (verify_hashes && sha256_file(&path, MAX_ARTIFACT_BYTES)? != artifact.sha256)
        {
            return Err(TestArtifactStoreError::InvalidArtifact);
        }
        total_bytes = total_bytes
            .checked_add(artifact.bytes)
            .ok_or(TestArtifactStoreError::ArtifactLimitExceeded)?;
        match artifact.kind {
            ArtifactKind::Trace => traces += 1,
            ArtifactKind::FailureScreenshot => failure_screenshots += 1,
            ArtifactKind::StepSnapshot => step_snapshots += 1,
            ArtifactKind::Screenshot => screenshots += 1,
        }
    }
    if total_bytes > MAX_RUN_ARTIFACT_BYTES
        || traces > 1
        || failure_screenshots > 1
        || step_snapshots > MAX_STEPS
        || screenshots > MAX_SCREENSHOT_STEPS
    {
        return Err(TestArtifactStoreError::ArtifactLimitExceeded);
    }
    let artifact_kind = |artifact_id: &str| {
        result
            .artifacts
            .iter()
            .find(|artifact| artifact.artifact_id == artifact_id)
            .map(|artifact| artifact.kind)
    };
    for step in &result.steps {
        if step
            .snapshot_artifact_id
            .as_deref()
            .is_some_and(|id| artifact_kind(id) != Some(ArtifactKind::StepSnapshot))
            || step
                .screenshot_artifact_id
                .as_deref()
                .is_some_and(|id| artifact_kind(id) != Some(ArtifactKind::Screenshot))
        {
            return Err(TestArtifactStoreError::InvalidData);
        }
    }
    if result.failure.as_ref().is_some_and(|failure| {
        failure
            .artifact_ids
            .iter()
            .any(|id| artifact_kind(id).is_none())
    }) {
        return Err(TestArtifactStoreError::InvalidData);
    }
    Ok(())
}

fn read_run_record(
    run_dir: &Path,
    run_id: Uuid,
    verify_artifact_hashes: bool,
) -> Result<StoredRunRecord, TestArtifactStoreError> {
    let manifest: TestRunManifest = read_json_file(run_dir, MANIFEST_FILE, MAX_RESULT_BYTES)?;
    validate_manifest(&manifest, run_id, run_dir)?;

    let journey_path = require_direct_file(run_dir, JOURNEY_FILE, MAX_PLAN_BYTES)?;
    let journey_bytes = fs::read(&journey_path).map_err(map_store_io_error)?;
    if sha256_bytes(&journey_bytes) != manifest.plan_sha256 {
        return Err(TestArtifactStoreError::InvalidData);
    }
    let plan: JourneyPlan =
        serde_json::from_slice(&journey_bytes).map_err(|_| TestArtifactStoreError::InvalidData)?;
    plan.validate()
        .map_err(|_| TestArtifactStoreError::InvalidData)?;
    if plan.run_id != run_id
        || plan.workspace_id != manifest.summary.workspace_id
        || plan.journey_id != manifest.summary.journey_id
        || plan.title != manifest.summary.title
        || plan.steps.len() != manifest.summary.total_steps
        || plan.graph_sha256 != manifest.summary.graph_sha256
    {
        return Err(TestArtifactStoreError::InvalidData);
    }

    let result_path = run_dir.join(RESULT_FILE);
    let mut result = match result_path.symlink_metadata() {
        Ok(_) => {
            let result_bytes =
                fs::read(require_direct_file(run_dir, RESULT_FILE, MAX_RESULT_BYTES)?)
                    .map_err(map_store_io_error)?;
            let result: TestRunResult = serde_json::from_slice(&result_bytes)
                .map_err(|_| TestArtifactStoreError::InvalidData)?;
            validate_result_against_plan(run_dir, &result, &plan, verify_artifact_hashes)?;
            if let Some(expected) = &manifest.result_sha256
                && sha256_bytes(&result_bytes) != *expected
            {
                return Err(TestArtifactStoreError::InvalidData);
            }
            Some(result)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(map_store_io_error(error)),
    };

    match manifest.summary.state {
        TestRunState::Running => {
            if manifest.result_sha256.is_some()
                || manifest.summary.completed_at_unix_ms.is_some()
                || manifest.summary.duration_ms.is_some()
                || manifest.summary.passed_steps != 0
                || manifest.summary.failed_steps != 0
                || manifest.summary.failed_step_id.is_some()
                || manifest.summary.message.is_some()
            {
                return Err(TestArtifactStoreError::InvalidData);
            }
            // A result without the final manifest digest is a bounded staged
            // write left between write_result and finalize. Recovery replaces
            // it with an explicit interrupted result.
            result = None;
        }
        TestRunState::Passed
        | TestRunState::Failed
        | TestRunState::TimedOut
        | TestRunState::Cancelled => {
            let result = result.as_ref().ok_or(TestArtifactStoreError::InvalidData)?;
            if manifest.result_sha256.is_none()
                || manifest.summary
                    != result.summary(
                        plan.title.clone(),
                        path_to_display(run_dir)?,
                        plan.steps.len(),
                    )
            {
                return Err(TestArtifactStoreError::InvalidData);
            }
        }
    }

    Ok(StoredRunRecord {
        manifest,
        plan,
        result,
    })
}

fn validate_result_against_plan(
    run_dir: &Path,
    result: &TestRunResult,
    plan: &JourneyPlan,
    verify_artifact_hashes: bool,
) -> Result<(), TestArtifactStoreError> {
    validate_result_identity(result)?;
    if result.run_id != plan.run_id
        || result.workspace_id != plan.workspace_id
        || result.journey_id != plan.journey_id
        || result.graph_sha256 != plan.graph_sha256
        || result.steps.len() > plan.steps.len()
        || result.console_errors.len() > MAX_CONSOLE_ERRORS
        || result.requests.len() > MAX_REQUESTS
        || elapsed_between(result.started_at_unix_ms, result.completed_at_unix_ms)
            != Some(result.duration_ms)
    {
        return Err(TestArtifactStoreError::InvalidData);
    }

    let mut saw_failed_step = false;
    for (index, step) in result.steps.iter().enumerate() {
        let planned = plan
            .steps
            .get(index)
            .ok_or(TestArtifactStoreError::InvalidData)?;
        if step.step_id != planned.id
            || step.label != planned.label
            || step.kind != step_kind_name(planned.action.kind())
            || step.started_at_unix_ms < result.started_at_unix_ms
            || step.completed_at_unix_ms < step.started_at_unix_ms
            || step.completed_at_unix_ms > result.completed_at_unix_ms
            || elapsed_between(step.started_at_unix_ms, step.completed_at_unix_ms)
                != Some(step.duration_ms)
            || saw_failed_step
        {
            return Err(TestArtifactStoreError::InvalidData);
        }
        match (step.state, &step.error) {
            (TestStepState::Passed, None) => {}
            (TestStepState::Failed, Some(error)) => {
                validate_text(error, MAX_ERROR_BYTES, false)
                    .map_err(|_| TestArtifactStoreError::InvalidData)?;
                saw_failed_step = true;
            }
            _ => return Err(TestArtifactStoreError::InvalidData),
        }
    }

    for entry in &result.console_errors {
        if !matches!(entry.kind.as_str(), "error" | "warning")
            || entry.timestamp_unix_ms < result.started_at_unix_ms
            || entry.timestamp_unix_ms > result.completed_at_unix_ms
        {
            return Err(TestArtifactStoreError::InvalidData);
        }
        validate_text(&entry.text, MAX_EVENT_TEXT_BYTES, false)
            .map_err(|_| TestArtifactStoreError::InvalidData)?;
    }
    for request in &result.requests {
        if request.method.is_empty()
            || request.method.len() > 32
            || !request.method.bytes().all(|byte| {
                byte.is_ascii_uppercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'_')
            })
            || !valid_request_summary_url(&request.url)
            || request
                .status
                .is_some_and(|status| !(100..=599).contains(&status))
        {
            return Err(TestArtifactStoreError::InvalidData);
        }
        validate_text(&request.url, MAX_PATH_BYTES, false)
            .map_err(|_| TestArtifactStoreError::InvalidData)?;
        if let Some(failure) = &request.failure {
            validate_text(failure, MAX_EVENT_TEXT_BYTES, false)
                .map_err(|_| TestArtifactStoreError::InvalidData)?;
        }
    }

    match result.state {
        TestRunState::Passed
            if result.steps.len() == plan.steps.len()
                && !saw_failed_step
                && result.failure.is_none() => {}
        TestRunState::Failed | TestRunState::TimedOut | TestRunState::Cancelled
            if result.failure.is_some() => {}
        _ => return Err(TestArtifactStoreError::InvalidData),
    }
    if let Some(failure) = &result.failure {
        validate_text(&failure.name, MAX_ID_BYTES, false)
            .map_err(|_| TestArtifactStoreError::InvalidData)?;
        validate_text(&failure.message, MAX_ERROR_BYTES, false)
            .map_err(|_| TestArtifactStoreError::InvalidData)?;
        if failure.console_errors.len() > MAX_CONSOLE_ERRORS
            || failure.failed_requests.len() > MAX_REQUESTS
            || failure
                .console_errors
                .iter()
                .any(|entry| !result.console_errors.contains(entry))
            || failure
                .failed_requests
                .iter()
                .any(|request| !result.requests.contains(request))
        {
            return Err(TestArtifactStoreError::InvalidData);
        }
        match &failure.failed_step_id {
            Some(step_id) => {
                let step = result
                    .steps
                    .iter()
                    .find(|step| &step.step_id == step_id)
                    .ok_or(TestArtifactStoreError::InvalidData)?;
                if step.state != TestStepState::Failed
                    || failure.failed_step_kind.as_deref() != Some(step.kind.as_str())
                {
                    return Err(TestArtifactStoreError::InvalidData);
                }
            }
            None if failure.failed_step_kind.is_none() => {}
            None => return Err(TestArtifactStoreError::InvalidData),
        }
    }
    validate_result_artifacts(run_dir, result, verify_artifact_hashes)
}

fn summary_recency(summary: &TestRunSummary) -> i64 {
    summary
        .completed_at_unix_ms
        .unwrap_or(summary.started_at_unix_ms)
        .max(summary.started_at_unix_ms)
}

fn fixed_child(parent: &Path, leaf: &str) -> Result<PathBuf, TestArtifactStoreError> {
    if leaf.is_empty()
        || leaf == "."
        || leaf == ".."
        || leaf.contains('/')
        || leaf.contains('\\')
        || leaf.contains('\0')
    {
        return Err(TestArtifactStoreError::InvalidPath);
    }
    Ok(parent.join(leaf))
}

fn require_direct_file(
    parent: &Path,
    leaf: &str,
    maximum_bytes: usize,
) -> Result<PathBuf, TestArtifactStoreError> {
    let path = fixed_child(parent, leaf)?;
    let metadata = path.symlink_metadata().map_err(map_store_io_error)?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > maximum_bytes as u64
    {
        return Err(TestArtifactStoreError::InvalidPath);
    }
    let canonical = path.canonicalize().map_err(map_store_io_error)?;
    if canonical != path {
        return Err(TestArtifactStoreError::InvalidPath);
    }
    Ok(path)
}

fn read_json_file<T: DeserializeOwned>(
    parent: &Path,
    leaf: &str,
    maximum_bytes: usize,
) -> Result<T, TestArtifactStoreError> {
    let bytes = read_bounded_file(parent, leaf, maximum_bytes)?;
    serde_json::from_slice(&bytes).map_err(|_| TestArtifactStoreError::InvalidData)
}

fn read_bounded_file(
    parent: &Path,
    leaf: &str,
    maximum_bytes: usize,
) -> Result<Vec<u8>, TestArtifactStoreError> {
    let path = require_direct_file(parent, leaf, maximum_bytes)?;
    fs::read(path).map_err(map_store_io_error)
}

fn atomic_replace_json(
    parent: &Path,
    leaf: &str,
    value: &impl Serialize,
    maximum_bytes: usize,
) -> Result<(), TestArtifactStoreError> {
    let bytes =
        serde_json::to_vec_pretty(value).map_err(|_| TestArtifactStoreError::InvalidData)?;
    atomic_replace_bytes(parent, leaf, &bytes, maximum_bytes)
}

fn atomic_replace_bytes(
    parent: &Path,
    leaf: &str,
    bytes: &[u8],
    maximum_bytes: usize,
) -> Result<(), TestArtifactStoreError> {
    let path = fixed_child(parent, leaf)?;
    if bytes.len() > maximum_bytes {
        return Err(TestArtifactStoreError::ArtifactLimitExceeded);
    }
    match path.symlink_metadata() {
        Ok(metadata)
            if metadata.is_file()
                && !metadata.file_type().is_symlink()
                && metadata.len() <= maximum_bytes as u64 => {}
        Ok(_) => return Err(TestArtifactStoreError::InvalidPath),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(map_store_io_error(error)),
    }
    let temp_leaf = format!(".{leaf}.{}.tmp", Uuid::new_v4().simple());
    let temp = fixed_child(parent, &temp_leaf)?;
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temp)
        .map_err(map_store_io_error)?;
    let result = (|| {
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temp, &path)?;
        File::open(parent)?.sync_all()?;
        Ok::<(), io::Error>(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
        return Err(TestArtifactStoreError::Unavailable);
    }
    Ok(())
}

fn safe_artifact_file(run_dir: &Path, relative: &str) -> Result<PathBuf, TestArtifactStoreError> {
    validate_text(relative, MAX_PATH_BYTES, false)
        .map_err(|_| TestArtifactStoreError::InvalidArtifact)?;
    let relative_path = Path::new(relative);
    if relative_path.is_absolute() {
        return Err(TestArtifactStoreError::InvalidArtifact);
    }
    let components = relative_path.components().collect::<Vec<_>>();
    if components.is_empty()
        || components.len() > 4
        || !components
            .iter()
            .all(|component| matches!(component, Component::Normal(_)))
    {
        return Err(TestArtifactStoreError::InvalidArtifact);
    }
    if components.len() == 1
        && matches!(
            relative,
            MANIFEST_FILE | JOURNEY_FILE | DRIVER_PLAN_FILE | DRIVER_OUTPUT_FILE | RESULT_FILE
        )
    {
        return Err(TestArtifactStoreError::InvalidArtifact);
    }
    let mut candidate = run_dir.to_owned();
    for component in components {
        candidate.push(component.as_os_str());
        let metadata = candidate
            .symlink_metadata()
            .map_err(|_| TestArtifactStoreError::InvalidArtifact)?;
        if metadata.file_type().is_symlink() {
            return Err(TestArtifactStoreError::InvalidArtifact);
        }
    }
    let canonical = candidate
        .canonicalize()
        .map_err(|_| TestArtifactStoreError::InvalidArtifact)?;
    if !canonical.starts_with(run_dir) || canonical == run_dir {
        return Err(TestArtifactStoreError::InvalidArtifact);
    }
    Ok(canonical)
}

fn directory_size_safely(root: &Path) -> Result<u64, TestArtifactStoreError> {
    let mut total = 0u64;
    let mut pending = vec![root.to_owned()];
    while let Some(directory) = pending.pop() {
        let metadata = directory.symlink_metadata().map_err(map_store_io_error)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(TestArtifactStoreError::InvalidPath);
        }
        for entry in fs::read_dir(&directory).map_err(map_store_io_error)? {
            let entry = entry.map_err(map_store_io_error)?;
            let path = entry.path();
            let metadata = path.symlink_metadata().map_err(map_store_io_error)?;
            if metadata.file_type().is_symlink() {
                return Err(TestArtifactStoreError::InvalidPath);
            }
            if metadata.is_dir() {
                pending.push(path);
            } else if metadata.is_file() {
                total = total
                    .checked_add(metadata.len())
                    .ok_or(TestArtifactStoreError::RetentionExceeded)?;
            } else {
                return Err(TestArtifactStoreError::InvalidPath);
            }
        }
    }
    Ok(total)
}

fn remove_tree_safely(parent: &Path, root: &Path) -> Result<(), TestArtifactStoreError> {
    if root.parent() != Some(parent) {
        return Err(TestArtifactStoreError::InvalidPath);
    }
    let metadata = root.symlink_metadata().map_err(map_store_io_error)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(TestArtifactStoreError::InvalidPath);
    }
    // `remove_dir_all` uses platform-safe recursive deletion and does not
    // follow directory symlinks. This avoids the check-then-walk race of a
    // hand-rolled path traversal after the direct run root is validated.
    fs::remove_dir_all(root).map_err(map_store_io_error)
}

fn sha256_file(path: &Path, maximum_bytes: u64) -> Result<String, TestArtifactStoreError> {
    let mut file = File::open(path).map_err(map_store_io_error)?;
    let metadata = file.metadata().map_err(map_store_io_error)?;
    if !metadata.is_file() || metadata.len() > maximum_bytes {
        return Err(TestArtifactStoreError::ArtifactLimitExceeded);
    }
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut read = 0u64;
    loop {
        let count = file.read(&mut buffer).map_err(map_store_io_error)?;
        if count == 0 {
            break;
        }
        read = read
            .checked_add(count as u64)
            .ok_or(TestArtifactStoreError::ArtifactLimitExceeded)?;
        if read > maximum_bytes {
            return Err(TestArtifactStoreError::ArtifactLimitExceeded);
        }
        hasher.update(&buffer[..count]);
    }
    Ok(hasher.finalize().encode_hex::<String>())
}

fn sha256_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher.finalize().encode_hex::<String>()
}

fn valid_sha256(value: &str) -> bool {
    valid_lower_sha256_hex(value)
}

fn valid_lower_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn path_to_display(path: &Path) -> Result<String, TestArtifactStoreError> {
    path.to_str()
        .map(ToOwned::to_owned)
        .ok_or(TestArtifactStoreError::InvalidPath)
}

fn unix_ms_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
        .unwrap_or(i64::MAX)
}

fn map_store_io_error(error: io::Error) -> TestArtifactStoreError {
    match error.kind() {
        io::ErrorKind::NotFound => TestArtifactStoreError::NotFound,
        _ => TestArtifactStoreError::Unavailable,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DriverJourneyPlan<'a> {
    schema_version: u32,
    run_id: Uuid,
    workspace_id: Uuid,
    journey_id: &'a str,
    title: &'a str,
    base_url: &'a str,
    allowed_origins: &'a [String],
    timeout_ms: u64,
    steps: Vec<&'a JourneyAction>,
}

impl<'a> From<&'a JourneyPlan> for DriverJourneyPlan<'a> {
    fn from(plan: &'a JourneyPlan) -> Self {
        Self {
            schema_version: TEST_RUN_SCHEMA_VERSION,
            run_id: plan.run_id,
            workspace_id: plan.workspace_id,
            journey_id: &plan.journey_id,
            title: &plan.title,
            base_url: &plan.base_url,
            allowed_origins: &plan.allowed_origins,
            timeout_ms: plan.timeout_ms,
            steps: plan.steps.iter().map(|step| &step.action).collect(),
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DriverOutput {
    schema_version: u32,
    status: DriverStatus,
    times: DriverTimes,
    duration: u64,
    steps: Vec<DriverStep>,
    console_errors: Vec<DriverConsoleError>,
    requests: Vec<DriverRequest>,
    failure: Option<DriverFailure>,
    artifacts: DriverArtifacts,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
enum DriverStatus {
    Passed,
    Failed,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DriverTimes {
    started_at_unix_ms: u64,
    completed_at_unix_ms: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DriverStep {
    index: usize,
    kind: JourneyStepKind,
    status: DriverStepStatus,
    started_at_unix_ms: u64,
    completed_at_unix_ms: u64,
    duration: u64,
    snapshot: Option<String>,
    screenshot: Option<String>,
    error: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
enum DriverStepStatus {
    Passed,
    Failed,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DriverConsoleError {
    #[serde(rename = "type")]
    kind: String,
    text: String,
    timestamp_unix_ms: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DriverRequest {
    method: String,
    url: String,
    status: Option<u16>,
    failure: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DriverFailure {
    step_index: Option<usize>,
    kind: Option<JourneyStepKind>,
    name: String,
    message: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DriverArtifacts {
    trace: Option<String>,
    failure_screenshot: Option<String>,
    step_snapshots: Vec<String>,
    screenshots: Vec<String>,
}

pub trait BrowserJourneyAdapter: Send + Sync {
    fn run(
        &self,
        plan: &JourneyPlan,
        store: &TestArtifactStore,
    ) -> Result<TestRunResult, BrowserJourneyFailure>;
}

/// Runs the bundled browser driver without a shell.
///
/// Both the Node executable and helper are canonical explicit files fixed when
/// the adapter is constructed. Callers can provide only a validated journey;
/// they cannot add flags, scripts, environment variables, or writable roots.
#[derive(Clone, Debug)]
pub struct ProcessBrowserJourneyAdapter {
    node_executable: PathBuf,
    helper_path: PathBuf,
    stream_limit_bytes: usize,
    process_grace: Duration,
}

impl ProcessBrowserJourneyAdapter {
    pub fn new(node_executable: &Path, helper_path: &Path) -> Result<Self, BrowserJourneyFailure> {
        let node_executable = canonical_executable(node_executable)?;
        let helper_path = canonical_executable(helper_path)?;
        Ok(Self {
            node_executable,
            helper_path,
            stream_limit_bytes: MAX_PROCESS_STREAM_BYTES,
            process_grace: PROCESS_GRACE,
        })
    }

    pub fn node_executable(&self) -> &Path {
        &self.node_executable
    }

    pub fn helper_path(&self) -> &Path {
        &self.helper_path
    }

    pub fn run(
        &self,
        plan: &JourneyPlan,
        store: &TestArtifactStore,
    ) -> Result<TestRunResult, BrowserJourneyFailure> {
        <Self as BrowserJourneyAdapter>::run(self, plan, store)
    }

    #[cfg(test)]
    fn with_stream_limit(mut self, stream_limit_bytes: usize) -> Self {
        self.stream_limit_bytes = stream_limit_bytes;
        self
    }

    #[cfg(test)]
    fn with_process_grace(mut self, process_grace: Duration) -> Self {
        self.process_grace = process_grace;
        self
    }

    fn finalize_failure(
        &self,
        plan: &JourneyPlan,
        store: &TestArtifactStore,
        manifest: &TestRunManifest,
        failure: BrowserJourneyFailure,
    ) -> BrowserJourneyFailure {
        let result = synthetic_failure_result(plan, manifest, &failure);
        if store.finalize(&result).is_err() {
            BrowserJourneyFailure::PersistenceFailed
        } else {
            failure
        }
    }
}

impl BrowserJourneyAdapter for ProcessBrowserJourneyAdapter {
    fn run(
        &self,
        plan: &JourneyPlan,
        store: &TestArtifactStore,
    ) -> Result<TestRunResult, BrowserJourneyFailure> {
        plan.validate()
            .map_err(BrowserJourneyFailure::InvalidPlan)?;
        let manifest = store.begin(plan).map_err(BrowserJourneyFailure::Store)?;
        let paths = match store.write_driver_plan(plan) {
            Ok(paths) => paths,
            Err(error) => {
                let failure = BrowserJourneyFailure::Store(error);
                return Err(self.finalize_failure(plan, store, &manifest, failure));
            }
        };

        let process = match run_browser_process(
            &self.node_executable,
            &self.helper_path,
            &paths,
            Duration::from_millis(plan.timeout_ms).saturating_add(self.process_grace),
            self.stream_limit_bytes,
        ) {
            Ok(process) => process,
            Err(failure) => {
                return Err(self.finalize_failure(plan, store, &manifest, failure));
            }
        };
        if !matches!(process.status.code(), Some(0) | Some(1)) {
            let failure = BrowserJourneyFailure::HelperFailed;
            return Err(self.finalize_failure(plan, store, &manifest, failure));
        }

        let output = match store.read_driver_output(&paths) {
            Ok(output) => output,
            Err(error) => {
                let failure = if process.status.success() {
                    BrowserJourneyFailure::InvalidResult
                } else {
                    match error {
                        TestArtifactStoreError::NotFound => BrowserJourneyFailure::HelperFailed,
                        _ => BrowserJourneyFailure::InvalidResult,
                    }
                };
                return Err(self.finalize_failure(plan, store, &manifest, failure));
            }
        };

        let exit_failure = match (process.status.code(), output.status) {
            (Some(0), DriverStatus::Passed) | (Some(1), DriverStatus::Failed) => None,
            (Some(0), _) | (Some(1), _) => Some(BrowserJourneyFailure::InvalidResult),
            // Exit 2 is the driver's invalid-input contract; signals and all
            // other codes are likewise infrastructure failures.
            _ => Some(BrowserJourneyFailure::HelperFailed),
        };
        if let Some(failure) = exit_failure {
            return Err(self.finalize_failure(plan, store, &manifest, failure));
        }
        let result = match convert_driver_output(plan, store, output) {
            Ok(result) => result,
            Err(failure) => {
                return Err(self.finalize_failure(plan, store, &manifest, failure));
            }
        };
        if let Err(error) = store.finalize(&result) {
            return Err(BrowserJourneyFailure::Store(error));
        }
        Ok(result)
    }
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum BrowserJourneyFailure {
    #[error("browser journey plan is invalid")]
    InvalidPlan(#[source] JourneyPlanError),
    #[error("browser journey storage failed")]
    Store(#[source] TestArtifactStoreError),
    #[error("Node or the browser helper is unavailable")]
    Unavailable,
    #[error("browser helper process could not be started or monitored")]
    SpawnFailed,
    #[error("browser helper exceeded its journey timeout")]
    TimedOut,
    #[error("browser helper exceeded its output transport limit")]
    OutputTooLarge,
    #[error("browser helper failed before producing a valid result")]
    HelperFailed,
    #[error("browser helper result violated the strict contract")]
    InvalidResult,
    #[error("browser helper produced an unsafe artifact reference")]
    InvalidArtifact,
    #[error("browser helper terminal failure could not be persisted")]
    PersistenceFailed,
}

impl BrowserJourneyFailure {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidPlan(_) => "invalidPlan",
            Self::Store(_) => "artifactStore",
            Self::Unavailable => "unavailable",
            Self::SpawnFailed => "spawnFailed",
            Self::TimedOut => "timedOut",
            Self::OutputTooLarge => "outputTooLarge",
            Self::HelperFailed => "helperFailed",
            Self::InvalidResult => "invalidResult",
            Self::InvalidArtifact => "invalidArtifact",
            Self::PersistenceFailed => "persistenceFailed",
        }
    }

    pub fn terminal_state(&self) -> TestRunState {
        match self {
            Self::TimedOut => TestRunState::TimedOut,
            _ => TestRunState::Failed,
        }
    }
}

struct BrowserProcessOutput {
    status: ExitStatus,
    #[allow(dead_code)]
    stdout: Vec<u8>,
    #[allow(dead_code)]
    stderr: Vec<u8>,
}

enum ReaderMessage {
    Complete(Vec<u8>),
    Failed,
    Overflow,
}

fn canonical_executable(path: &Path) -> Result<PathBuf, BrowserJourneyFailure> {
    if !path.is_absolute() {
        return Err(BrowserJourneyFailure::Unavailable);
    }
    let canonical = path
        .canonicalize()
        .map_err(|_| BrowserJourneyFailure::Unavailable)?;
    let metadata = canonical
        .symlink_metadata()
        .map_err(|_| BrowserJourneyFailure::Unavailable)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(BrowserJourneyFailure::Unavailable);
    }
    Ok(canonical)
}

fn run_browser_process(
    node_executable: &Path,
    helper_path: &Path,
    paths: &ProcessRunPaths,
    timeout: Duration,
    stream_limit: usize,
) -> Result<BrowserProcessOutput, BrowserJourneyFailure> {
    let started = Instant::now();
    let mut command = Command::new(node_executable);
    command
        .arg(helper_path)
        .arg("--plan")
        .arg(&paths.plan_path)
        .arg("--artifacts")
        .arg(&paths.artifacts_dir)
        .arg("--output")
        .arg(&paths.output_path)
        .current_dir(&paths.run_dir)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    copy_browser_environment(&mut command);
    configure_process_group(&mut command);
    let mut child = command.spawn().map_err(|error| match error.kind() {
        io::ErrorKind::NotFound | io::ErrorKind::PermissionDenied => {
            BrowserJourneyFailure::Unavailable
        }
        _ => BrowserJourneyFailure::SpawnFailed,
    })?;
    let Some(stdout) = child.stdout.take() else {
        terminate_browser_child(&mut child, false);
        return Err(BrowserJourneyFailure::SpawnFailed);
    };
    let Some(stderr) = child.stderr.take() else {
        terminate_browser_child(&mut child, false);
        return Err(BrowserJourneyFailure::SpawnFailed);
    };
    let stdout_reader = spawn_process_reader(stdout, stream_limit);
    let stderr_reader = spawn_process_reader(stderr, stream_limit);
    let mut stdout = None;
    let mut stderr = None;

    let status = loop {
        poll_process_reader(&stdout_reader, &mut stdout, &mut child)?;
        poll_process_reader(&stderr_reader, &mut stderr, &mut child)?;
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < timeout => thread::sleep(PROCESS_POLL_INTERVAL),
            Ok(None) => {
                terminate_browser_child(&mut child, false);
                drain_readers(stdout_reader, stderr_reader);
                return Err(BrowserJourneyFailure::TimedOut);
            }
            Err(_) => {
                terminate_browser_child(&mut child, false);
                drain_readers(stdout_reader, stderr_reader);
                return Err(BrowserJourneyFailure::SpawnFailed);
            }
        }
    };

    // The direct helper can exit while a browser or another descendant still
    // owns a pipe. Reap the remainder of only this owned process group before
    // waiting for readers, on successful and failed journeys alike.
    terminate_browser_child(&mut child, true);
    let remaining = timeout.saturating_sub(started.elapsed());
    let stdout = finish_process_reader(stdout_reader, stdout, remaining)?;
    let stderr = finish_process_reader(stderr_reader, stderr, remaining)?;
    Ok(BrowserProcessOutput {
        status,
        stdout,
        stderr,
    })
}

fn spawn_process_reader(
    mut reader: impl Read + Send + 'static,
    limit: usize,
) -> Receiver<ReaderMessage> {
    let (sender, receiver) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let outcome = match reader
            .by_ref()
            .take((limit.saturating_add(1)) as u64)
            .read_to_end(&mut bytes)
        {
            Ok(_) if bytes.len() <= limit => ReaderMessage::Complete(bytes),
            Ok(_) => ReaderMessage::Overflow,
            Err(_) => ReaderMessage::Failed,
        };
        let _ = sender.send(outcome);
    });
    receiver
}

fn poll_process_reader(
    receiver: &Receiver<ReaderMessage>,
    output: &mut Option<Vec<u8>>,
    child: &mut Child,
) -> Result<(), BrowserJourneyFailure> {
    if output.is_some() {
        return Ok(());
    }
    match receiver.try_recv() {
        Ok(ReaderMessage::Complete(bytes)) => {
            *output = Some(bytes);
            Ok(())
        }
        Ok(ReaderMessage::Overflow) => {
            terminate_browser_child(child, false);
            Err(BrowserJourneyFailure::OutputTooLarge)
        }
        Ok(ReaderMessage::Failed) | Err(TryRecvError::Disconnected) => {
            terminate_browser_child(child, false);
            Err(BrowserJourneyFailure::SpawnFailed)
        }
        Err(TryRecvError::Empty) => Ok(()),
    }
}

fn finish_process_reader(
    receiver: Receiver<ReaderMessage>,
    output: Option<Vec<u8>>,
    remaining: Duration,
) -> Result<Vec<u8>, BrowserJourneyFailure> {
    if let Some(output) = output {
        return Ok(output);
    }
    match receiver.recv_timeout(remaining.min(Duration::from_secs(2))) {
        Ok(ReaderMessage::Complete(bytes)) => Ok(bytes),
        Ok(ReaderMessage::Overflow) => Err(BrowserJourneyFailure::OutputTooLarge),
        Ok(ReaderMessage::Failed) | Err(_) => Err(BrowserJourneyFailure::SpawnFailed),
    }
}

fn drain_readers(stdout: Receiver<ReaderMessage>, stderr: Receiver<ReaderMessage>) {
    let _ = stdout.recv_timeout(Duration::from_secs(1));
    let _ = stderr.recv_timeout(Duration::from_secs(1));
}

fn terminate_browser_child(child: &mut Child, already_reaped: bool) {
    let _ = terminate_process_group(child, already_reaped);
}

fn copy_browser_environment(command: &mut Command) {
    for name in [
        "PATH",
        "HOME",
        "TMPDIR",
        "TEMP",
        "TMP",
        "USERPROFILE",
        "SystemRoot",
        "PATHEXT",
        "PLAYWRIGHT_BROWSERS_PATH",
    ] {
        if let Some(value) = env::var_os(name) {
            command.env(name, value);
        }
    }
    command.env("CI", "1");
}

fn convert_driver_output(
    plan: &JourneyPlan,
    store: &TestArtifactStore,
    output: DriverOutput,
) -> Result<TestRunResult, BrowserJourneyFailure> {
    validate_driver_output(plan, &output)?;
    let artifacts = store
        .collect_artifacts(plan.run_id, &output.artifacts)
        .map_err(|error| match error {
            TestArtifactStoreError::InvalidArtifact
            | TestArtifactStoreError::InvalidPath
            | TestArtifactStoreError::ArtifactLimitExceeded => {
                BrowserJourneyFailure::InvalidArtifact
            }
            other => BrowserJourneyFailure::Store(other),
        })?;
    let artifact_id = |relative: &str| {
        artifacts
            .iter()
            .find(|artifact| artifact.relative_path == relative)
            .map(|artifact| artifact.artifact_id.clone())
    };

    let mut steps = Vec::with_capacity(output.steps.len());
    for driver_step in &output.steps {
        let planned = &plan.steps[driver_step.index];
        steps.push(TestStepResult {
            step_id: planned.id.clone(),
            label: planned.label.clone(),
            kind: step_kind_name(driver_step.kind).to_owned(),
            state: match driver_step.status {
                DriverStepStatus::Passed => TestStepState::Passed,
                DriverStepStatus::Failed => TestStepState::Failed,
            },
            started_at_unix_ms: driver_timestamp(driver_step.started_at_unix_ms)?,
            completed_at_unix_ms: driver_timestamp(driver_step.completed_at_unix_ms)?,
            duration_ms: driver_step.duration,
            snapshot_artifact_id: driver_step.snapshot.as_deref().and_then(&artifact_id),
            screenshot_artifact_id: driver_step.screenshot.as_deref().and_then(&artifact_id),
            error: driver_step.error.clone(),
        });
    }
    let console_errors = output
        .console_errors
        .into_iter()
        .map(|entry| {
            Ok(ConsoleErrorSummary {
                kind: entry.kind,
                text: entry.text,
                timestamp_unix_ms: driver_timestamp(entry.timestamp_unix_ms)?,
            })
        })
        .collect::<Result<Vec<_>, BrowserJourneyFailure>>()?;
    let requests = output
        .requests
        .into_iter()
        .map(|request| RequestSummary {
            method: request.method,
            url: summarize_request_url(&plan.base_url, &request.url),
            status: request.status,
            failure: request.failure,
        })
        .collect::<Vec<_>>();
    let failure = output.failure.map(|failure| {
        let failed_step_id = failure
            .step_index
            .and_then(|index| plan.steps.get(index))
            .map(|step| step.id.clone());
        FailureCapsule {
            failed_step_id,
            failed_step_kind: failure.kind.map(step_kind_name).map(ToOwned::to_owned),
            name: failure.name,
            message: failure.message,
            console_errors: console_errors.clone(),
            failed_requests: requests
                .iter()
                .filter(|request| {
                    request.failure.is_some() || request.status.is_some_and(|status| status >= 400)
                })
                .cloned()
                .collect(),
            artifact_ids: artifacts
                .iter()
                .map(|artifact| artifact.artifact_id.clone())
                .collect(),
        }
    });
    Ok(TestRunResult {
        schema_version: TEST_RUN_SCHEMA_VERSION,
        run_id: plan.run_id,
        workspace_id: plan.workspace_id,
        journey_id: plan.journey_id.clone(),
        state: match output.status {
            DriverStatus::Passed => TestRunState::Passed,
            DriverStatus::Failed => TestRunState::Failed,
        },
        started_at_unix_ms: driver_timestamp(output.times.started_at_unix_ms)?,
        completed_at_unix_ms: driver_timestamp(output.times.completed_at_unix_ms)?,
        duration_ms: output.duration,
        steps,
        console_errors,
        requests,
        artifacts,
        failure,
        graph_sha256: plan.graph_sha256.clone(),
    })
}

fn validate_driver_output(
    plan: &JourneyPlan,
    output: &DriverOutput,
) -> Result<(), BrowserJourneyFailure> {
    if output.schema_version != TEST_RUN_SCHEMA_VERSION
        || driver_timestamp(output.times.started_at_unix_ms).is_err()
        || driver_timestamp(output.times.completed_at_unix_ms).is_err()
        || output
            .times
            .completed_at_unix_ms
            .checked_sub(output.times.started_at_unix_ms)
            != Some(output.duration)
        || output.duration > plan.timeout_ms.saturating_add(DRIVER_OUTPUT_GRACE_MS)
        || output.steps.len() > plan.steps.len()
        || output.console_errors.len() > MAX_CONSOLE_ERRORS
        || output.requests.len() > MAX_REQUESTS
    {
        return Err(BrowserJourneyFailure::InvalidResult);
    }

    let mut saw_failure = false;
    for (index, step) in output.steps.iter().enumerate() {
        let Some(planned) = plan.steps.get(index) else {
            return Err(BrowserJourneyFailure::InvalidResult);
        };
        if step.index != index
            || step.kind != planned.action.kind()
            || step.started_at_unix_ms < output.times.started_at_unix_ms
            || step.completed_at_unix_ms < step.started_at_unix_ms
            || step.completed_at_unix_ms > output.times.completed_at_unix_ms
            || step
                .completed_at_unix_ms
                .checked_sub(step.started_at_unix_ms)
                != Some(step.duration)
            || driver_timestamp(step.started_at_unix_ms).is_err()
            || driver_timestamp(step.completed_at_unix_ms).is_err()
            || step.duration
                > MAX_DRIVER_STEP_RESULT_MS
                    .min(plan.timeout_ms.saturating_add(DRIVER_OUTPUT_GRACE_MS))
            || saw_failure
        {
            return Err(BrowserJourneyFailure::InvalidResult);
        }
        match (step.status, &step.error) {
            (DriverStepStatus::Passed, None) => {}
            (DriverStepStatus::Failed, Some(error)) => {
                validate_output_text(error, MAX_ERROR_BYTES)?;
                saw_failure = true;
            }
            _ => return Err(BrowserJourneyFailure::InvalidResult),
        }
        if let Some(relative) = &step.snapshot {
            validate_artifact_reference(relative)?;
            if !output.artifacts.step_snapshots.contains(relative) {
                return Err(BrowserJourneyFailure::InvalidResult);
            }
        }
        if let Some(relative) = &step.screenshot {
            validate_artifact_reference(relative)?;
            if step.kind != JourneyStepKind::Screenshot
                || !output.artifacts.screenshots.contains(relative)
            {
                return Err(BrowserJourneyFailure::InvalidResult);
            }
        }
    }

    for entry in &output.console_errors {
        if !matches!(entry.kind.as_str(), "error" | "warning")
            || entry.timestamp_unix_ms < output.times.started_at_unix_ms
            || entry.timestamp_unix_ms > output.times.completed_at_unix_ms
            || driver_timestamp(entry.timestamp_unix_ms).is_err()
        {
            return Err(BrowserJourneyFailure::InvalidResult);
        }
        validate_output_text(&entry.text, MAX_EVENT_TEXT_BYTES)?;
    }
    for request in &output.requests {
        if request.method.is_empty()
            || request.method.len() > 32
            || !request.method.bytes().all(|byte| {
                byte.is_ascii_uppercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'_')
            })
            || request
                .status
                .is_some_and(|status| !(100..=599).contains(&status))
        {
            return Err(BrowserJourneyFailure::InvalidResult);
        }
        validate_output_text(&request.url, MAX_PATH_BYTES)?;
        if let Some(failure) = &request.failure {
            validate_output_text(failure, MAX_EVENT_TEXT_BYTES)?;
        }
    }
    if let Some(failure) = &output.failure {
        validate_output_text(&failure.name, MAX_ID_BYTES)?;
        validate_output_text(&failure.message, MAX_ERROR_BYTES)?;
        match failure.step_index {
            Some(index) => {
                let step = output
                    .steps
                    .get(index)
                    .ok_or(BrowserJourneyFailure::InvalidResult)?;
                if step.status != DriverStepStatus::Failed
                    || failure.kind != Some(step.kind)
                    || index + 1 != output.steps.len()
                {
                    return Err(BrowserJourneyFailure::InvalidResult);
                }
            }
            None if failure.kind.is_none() => {}
            None => return Err(BrowserJourneyFailure::InvalidResult),
        }
    }
    validate_driver_artifact_references(&output.artifacts)?;

    match output.status {
        DriverStatus::Passed
            if output.failure.is_none()
                && !saw_failure
                && output.steps.len() == plan.steps.len() => {}
        DriverStatus::Failed if output.failure.is_some() => {}
        _ => return Err(BrowserJourneyFailure::InvalidResult),
    }
    Ok(())
}

fn validate_driver_artifact_references(
    artifacts: &DriverArtifacts,
) -> Result<(), BrowserJourneyFailure> {
    if artifacts.step_snapshots.len() > MAX_STEPS
        || artifacts.screenshots.len() > MAX_SCREENSHOT_STEPS
    {
        return Err(BrowserJourneyFailure::InvalidResult);
    }
    let mut references = Vec::new();
    if let Some(reference) = &artifacts.trace {
        references.push(reference);
    }
    if let Some(reference) = &artifacts.failure_screenshot {
        references.push(reference);
    }
    references.extend(&artifacts.step_snapshots);
    references.extend(&artifacts.screenshots);
    let mut seen = HashSet::with_capacity(references.len());
    for reference in references {
        validate_artifact_reference(reference)?;
        if !seen.insert(reference.as_str()) {
            return Err(BrowserJourneyFailure::InvalidResult);
        }
    }
    Ok(())
}

fn validate_artifact_reference(reference: &str) -> Result<(), BrowserJourneyFailure> {
    validate_text(reference, MAX_PATH_BYTES, false)
        .map_err(|_| BrowserJourneyFailure::InvalidArtifact)?;
    let path = Path::new(reference);
    if path.is_absolute()
        || path.components().count() > 4
        || !path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
    {
        return Err(BrowserJourneyFailure::InvalidArtifact);
    }
    Ok(())
}

fn validate_output_text(value: &str, maximum_bytes: usize) -> Result<(), BrowserJourneyFailure> {
    validate_text(value, maximum_bytes, false).map_err(|_| BrowserJourneyFailure::InvalidResult)
}

fn driver_timestamp(value: u64) -> Result<i64, BrowserJourneyFailure> {
    i64::try_from(value).map_err(|_| BrowserJourneyFailure::InvalidResult)
}

fn summarize_request_url(base_url: &str, url: &str) -> String {
    let candidate = if let Some(suffix) = url.strip_prefix(base_url) {
        if suffix.is_empty() || suffix.starts_with('/') {
            suffix
        } else {
            return "[external]".to_owned();
        }
    } else if url.starts_with('/') && !url.starts_with("//") {
        url
    } else {
        return "[external]".to_owned();
    };
    candidate
        .split(['?', '#'])
        .next()
        .filter(|path| !path.is_empty())
        .unwrap_or("/")
        .to_owned()
}

fn valid_request_summary_url(value: &str) -> bool {
    value == "[external]"
        || (value.starts_with('/') && !value.starts_with("//") && !value.contains(['?', '#']))
}

fn elapsed_between(started: i64, completed: i64) -> Option<u64> {
    completed
        .checked_sub(started)
        .and_then(|duration| u64::try_from(duration).ok())
}

fn step_kind_name(kind: JourneyStepKind) -> &'static str {
    match kind {
        JourneyStepKind::Navigate => "navigate",
        JourneyStepKind::Click => "click",
        JourneyStepKind::Fill => "fill",
        JourneyStepKind::Select => "select",
        JourneyStepKind::Check => "check",
        JourneyStepKind::Press => "press",
        JourneyStepKind::AssertVisible => "assertVisible",
        JourneyStepKind::AssertText => "assertText",
        JourneyStepKind::AssertUrl => "assertUrl",
        JourneyStepKind::Screenshot => "screenshot",
    }
}

fn synthetic_failure_result(
    plan: &JourneyPlan,
    manifest: &TestRunManifest,
    failure: &BrowserJourneyFailure,
) -> TestRunResult {
    let completed_at_unix_ms = unix_ms_now().max(manifest.summary.started_at_unix_ms);
    let duration_ms = elapsed_between(manifest.summary.started_at_unix_ms, completed_at_unix_ms)
        .unwrap_or(u64::MAX);
    TestRunResult {
        schema_version: TEST_RUN_SCHEMA_VERSION,
        run_id: plan.run_id,
        workspace_id: plan.workspace_id,
        journey_id: plan.journey_id.clone(),
        state: failure.terminal_state(),
        started_at_unix_ms: manifest.summary.started_at_unix_ms,
        completed_at_unix_ms,
        duration_ms,
        steps: Vec::new(),
        console_errors: Vec::new(),
        requests: Vec::new(),
        artifacts: Vec::new(),
        failure: Some(FailureCapsule {
            failed_step_id: None,
            failed_step_kind: None,
            name: failure.code().to_owned(),
            message: failure.to_string(),
            console_errors: Vec::new(),
            failed_requests: Vec::new(),
            artifact_ids: Vec::new(),
        }),
        graph_sha256: plan.graph_sha256.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::{TempDir, tempdir};

    fn fixture_store() -> (TempDir, TestArtifactStore) {
        fixture_store_with_retention(TestArtifactRetention::default())
    }

    fn fixture_store_with_retention(
        retention: TestArtifactRetention,
    ) -> (TempDir, TestArtifactStore) {
        let fixture = tempdir().expect("temporary fixture");
        let workspace = fixture.path().join("workspace");
        fs::create_dir(&workspace).expect("workspace");
        let workspace = workspace.canonicalize().expect("canonical workspace");
        let store =
            TestArtifactStore::open_with_retention(&workspace, retention).expect("artifact store");
        (fixture, store)
    }

    fn navigate_plan(run_id: Uuid, workspace_id: Uuid) -> JourneyPlan {
        JourneyPlan::new(
            run_id,
            workspace_id,
            "wts-help-preferences",
            "Open help and preferences",
            "http://127.0.0.1:41000",
            1_000,
            vec![
                JourneyStep::new(
                    "open-help",
                    "Open help",
                    1_000,
                    JourneyAction::Navigate {
                        path: "/help".to_owned(),
                    },
                )
                .expect("journey step"),
            ],
        )
        .expect("journey plan")
    }

    fn screenshot_plan(run_id: Uuid, workspace_id: Uuid) -> JourneyPlan {
        JourneyPlan::new(
            run_id,
            workspace_id,
            "screenshot",
            "Capture screenshot",
            "http://localhost:41000",
            1_000,
            vec![
                JourneyStep::new("capture", "Capture", 1_000, JourneyAction::Screenshot)
                    .expect("journey step"),
            ],
        )
        .expect("journey plan")
    }

    fn write_helper(fixture: &TempDir, name: &str, script: &str) -> PathBuf {
        let helper = fixture.path().join(name);
        fs::write(&helper, script).expect("write helper");
        helper.canonicalize().expect("canonical helper")
    }

    fn shell() -> PathBuf {
        Path::new("/bin/sh")
            .canonicalize()
            .expect("canonical shell")
    }

    #[test]
    fn validates_closed_loopback_journey_contract() {
        let workspace_id = Uuid::new_v4();
        for origin in [
            "http://127.0.0.1:41000",
            "https://localhost:9443",
            "http://[::1]:41000",
        ] {
            let plan = JourneyPlan::new(
                Uuid::new_v4(),
                workspace_id,
                "safe",
                "Safe journey",
                origin,
                30_000,
                vec![
                    JourneyStep::new(
                        "navigate",
                        "Navigate",
                        5_000,
                        JourneyAction::Navigate {
                            path: "/settings?tab=agents".to_owned(),
                        },
                    )
                    .expect("step"),
                ],
            );
            assert!(plan.is_ok(), "{origin}");
        }

        for origin in [
            "https://example.com",
            "file:///tmp/index.html",
            "http://localhost:80",
            "http://LOCALHOST:41000",
            "http://127.0.0.1:041000",
            "http://127.0.0.1:41000/path",
            "http://user@localhost:41000",
        ] {
            let error = JourneyPlan::new(
                Uuid::new_v4(),
                workspace_id,
                "unsafe",
                "Unsafe journey",
                origin,
                30_000,
                vec![
                    JourneyStep::new(
                        "navigate",
                        "Navigate",
                        5_000,
                        JourneyAction::Navigate {
                            path: "/".to_owned(),
                        },
                    )
                    .expect("step"),
                ],
            )
            .expect_err("origin must be rejected");
            assert_eq!(error, JourneyPlanError::BaseUrl, "{origin}");
        }
    }

    #[test]
    fn rejects_origin_escape_duplicate_ids_and_invalid_graph_digest() {
        let workspace_id = Uuid::new_v4();
        let traversal = JourneyStep::new(
            "escape",
            "Escape",
            5_000,
            JourneyAction::Navigate {
                path: "//attacker.invalid".to_owned(),
            },
        );
        assert_eq!(
            traversal.expect_err("network-path reference"),
            JourneyPlanError::RelativePath
        );

        let step =
            JourneyStep::new("same", "Same", 5_000, JourneyAction::Screenshot).expect("step");
        let duplicate = JourneyPlan::new(
            Uuid::new_v4(),
            workspace_id,
            "duplicates",
            "Duplicates",
            "http://localhost:41000",
            30_000,
            vec![step.clone(), step],
        );
        assert_eq!(
            duplicate.expect_err("duplicate step"),
            JourneyPlanError::DuplicateStepId
        );

        let plan = navigate_plan(Uuid::new_v4(), workspace_id);
        assert_eq!(
            plan.with_graph_sha256("ABC")
                .expect_err("invalid graph hash"),
            JourneyPlanError::GraphDigest
        );
    }

    #[test]
    fn serde_rejects_arbitrary_selectors_javascript_and_unknown_fields() {
        let css_target = serde_json::from_value::<JourneyTarget>(json!({
            "kind": "css",
            "value": "body"
        }));
        assert!(css_target.is_err());

        let javascript = serde_json::from_value::<JourneyAction>(json!({
            "kind": "evaluate",
            "script": "document.cookie"
        }));
        assert!(javascript.is_err());

        let extra = serde_json::from_value::<JourneyAction>(json!({
            "kind": "click",
            "target": {
                "kind": "testId",
                "value": "save",
                "selector": "#save"
            }
        }));
        assert!(extra.is_err());
    }

    #[test]
    fn private_driver_plan_has_the_exact_flat_contract() {
        let plan = navigate_plan(Uuid::new_v4(), Uuid::new_v4())
            .with_graph_sha256("a".repeat(64))
            .expect("graph digest");
        let value =
            serde_json::to_value(DriverJourneyPlan::from(&plan)).expect("driver plan value");
        let object = value.as_object().expect("object");
        assert_eq!(
            object.keys().cloned().collect::<HashSet<_>>(),
            [
                "schemaVersion",
                "runId",
                "workspaceId",
                "journeyId",
                "title",
                "baseUrl",
                "allowedOrigins",
                "timeoutMs",
                "steps",
            ]
            .into_iter()
            .map(ToOwned::to_owned)
            .collect::<HashSet<_>>()
        );
        assert_eq!(
            value["steps"][0],
            json!({"kind": "navigate", "path": "/help"})
        );
        assert!(object.get("graphSha256").is_none());

        let key_plan = JourneyPlan::new(
            Uuid::new_v4(),
            Uuid::new_v4(),
            "keyboard",
            "Keyboard",
            "http://127.0.0.1:41000",
            1_000,
            vec![
                JourneyStep::new(
                    "press-up",
                    "Press up",
                    1_000,
                    JourneyAction::Press {
                        target: JourneyTarget::test_id("menu").expect("target"),
                        key: JourneyKey::ArrowUp,
                    },
                )
                .expect("step"),
            ],
        )
        .expect("key plan");
        let key_value =
            serde_json::to_value(DriverJourneyPlan::from(&key_plan)).expect("key plan value");
        assert_eq!(key_value["steps"][0]["key"], json!("ArrowUp"));
    }

    #[test]
    fn store_creates_atomic_running_manifest_and_lists_newest_first() {
        let (_fixture, store) = fixture_store();
        let workspace_id = Uuid::new_v4();
        let first = navigate_plan(Uuid::new_v4(), workspace_id);
        let first_manifest = store.begin(&first).expect("begin first");
        assert_eq!(first_manifest.summary.state, TestRunState::Running);
        thread::sleep(Duration::from_millis(2));
        let second = navigate_plan(Uuid::new_v4(), workspace_id);
        store.begin(&second).expect("begin second");

        let summaries = store.list().expect("list runs");
        assert_eq!(summaries.len(), 2);
        assert_eq!(summaries[0].run_id, second.run_id);
        let second_dir = store
            .run_directory(second.run_id)
            .expect("run directory")
            .expect("existing");
        assert!(fs::read_dir(second_dir).expect("entries").all(|entry| {
            !entry
                .expect("entry")
                .file_name()
                .to_string_lossy()
                .ends_with(".tmp")
        }));
        let first_dir = store
            .run_directory(first.run_id)
            .expect("first directory")
            .expect("first exists");
        fs::write(first_dir.join(JOURNEY_FILE), b"{}").expect("tamper plan");
        assert_eq!(
            store.list().expect_err("plan digest mismatch"),
            TestArtifactStoreError::InvalidData
        );
    }

    #[test]
    fn recovery_terminalizes_only_stale_running_manifests() {
        let (_fixture, store) = fixture_store();
        let workspace_root = store.workspace_root().to_owned();
        let workspace_id = Uuid::new_v4();
        let stale = navigate_plan(Uuid::new_v4(), workspace_id)
            .with_graph_sha256("c".repeat(64))
            .expect("graph pin");
        let fresh = navigate_plan(Uuid::new_v4(), workspace_id);
        let mut stale_manifest = store.begin(&stale).expect("stale run");
        store.begin(&fresh).expect("fresh run");
        let grace_ms = stale
            .timeout_ms
            .saturating_add(u64::try_from(PROCESS_GRACE.as_millis()).expect("process grace"))
            .saturating_add(
                u64::try_from(INTERRUPTED_RECONCILIATION_GRACE.as_millis())
                    .expect("recovery grace"),
            );
        stale_manifest.summary.started_at_unix_ms =
            unix_ms_now().saturating_sub(i64::try_from(grace_ms).expect("bounded grace") + 1);
        let stale_dir = store
            .run_directory(stale.run_id)
            .expect("run directory")
            .expect("stale run directory");
        atomic_replace_json(&stale_dir, MANIFEST_FILE, &stale_manifest, MAX_RESULT_BYTES)
            .expect("age running manifest");

        let reopened = TestArtifactStore::open(&workspace_root).expect("reopen store");
        let recovered = reopened.recover_interrupted().expect("recover");
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].run_id, stale.run_id);
        assert_eq!(recovered[0].state, TestRunState::Cancelled);
        assert_eq!(recovered[0].passed_steps, 0);
        assert_eq!(recovered[0].failed_steps, 0);
        assert_eq!(recovered[0].total_steps, stale.steps.len());
        assert_eq!(recovered[0].graph_sha256, stale.graph_sha256);
        let result = reopened
            .read(stale.run_id)
            .expect("read recovered")
            .expect("recovered result");
        assert_eq!(result.state, TestRunState::Cancelled);
        assert_eq!(
            result.failure.as_ref().map(|failure| failure.name.as_str()),
            Some("interrupted")
        );
        assert_eq!(
            reopened
                .read_manifest(fresh.run_id)
                .expect("fresh manifest")
                .expect("fresh run")
                .summary
                .state,
            TestRunState::Running
        );
        assert!(
            reopened
                .recover_interrupted()
                .expect("idempotent")
                .is_empty()
        );
    }

    #[test]
    fn count_and_byte_retention_keep_the_newest_complete_prefix() {
        let retention = TestArtifactRetention::new(2, 16 * 1024 * 1024).expect("retention");
        let (_fixture, store) = fixture_store_with_retention(retention);
        let workspace_id = Uuid::new_v4();
        let first = navigate_plan(Uuid::new_v4(), workspace_id);
        store.begin(&first).expect("first");
        thread::sleep(Duration::from_millis(2));
        let second = navigate_plan(Uuid::new_v4(), workspace_id);
        store.begin(&second).expect("second");
        thread::sleep(Duration::from_millis(2));
        let third = navigate_plan(Uuid::new_v4(), workspace_id);
        store.begin(&third).expect("third");
        assert_eq!(
            store
                .list()
                .expect("count retained")
                .iter()
                .map(|summary| summary.run_id)
                .collect::<Vec<_>>(),
            vec![third.run_id, second.run_id]
        );

        let newest_dir = store
            .run_directory(third.run_id)
            .expect("newest directory")
            .expect("newest exists");
        let newest_bytes = directory_size_safely(&newest_dir).expect("newest bytes");
        let byte_bounded = TestArtifactStore {
            retention: TestArtifactRetention::new(10, newest_bytes).expect("byte retention"),
            ..store.clone()
        };
        byte_bounded.enforce_retention().expect("byte prune");
        let retained = byte_bounded.list().expect("byte retained");
        assert_eq!(retained.len(), 1);
        assert_eq!(retained[0].run_id, third.run_id);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_roots_and_artifacts() {
        use std::os::unix::fs::symlink;

        let fixture = tempdir().expect("fixture");
        let workspace = fixture.path().join("workspace");
        let outside = fixture.path().join("outside");
        fs::create_dir_all(workspace.join(WTS_DIRECTORY)).expect("wts root");
        fs::create_dir(&outside).expect("outside");
        symlink(
            &outside,
            workspace.join(WTS_DIRECTORY).join(TEST_RUNS_DIRECTORY),
        )
        .expect("test-runs symlink");
        let workspace = workspace.canonicalize().expect("canonical workspace");
        assert_eq!(
            TestArtifactStore::open(&workspace).expect_err("symlink root"),
            TestArtifactStoreError::InvalidPath
        );

        let (_fixture, store) = fixture_store();
        let plan = screenshot_plan(Uuid::new_v4(), Uuid::new_v4());
        store.begin(&plan).expect("begin run");
        let run_dir = store
            .run_directory(plan.run_id)
            .expect("run directory")
            .expect("exists");
        let outside_file = store.workspace_root().join("outside.txt");
        fs::write(&outside_file, b"secret").expect("outside file");
        symlink(&outside_file, run_dir.join("escape.png")).expect("artifact symlink");
        let artifacts = DriverArtifacts {
            trace: None,
            failure_screenshot: None,
            step_snapshots: Vec::new(),
            screenshots: vec!["escape.png".to_owned()],
        };
        assert_eq!(
            store
                .collect_artifacts(plan.run_id, &artifacts)
                .expect_err("symlink artifact"),
            TestArtifactStoreError::InvalidArtifact
        );
    }

    #[test]
    fn rejects_artifact_traversal() {
        let (_fixture, store) = fixture_store();
        let plan = screenshot_plan(Uuid::new_v4(), Uuid::new_v4());
        store.begin(&plan).expect("begin run");
        let artifacts = DriverArtifacts {
            trace: Some("../outside.zip".to_owned()),
            failure_screenshot: None,
            step_snapshots: Vec::new(),
            screenshots: Vec::new(),
        };
        assert_eq!(
            store
                .collect_artifacts(plan.run_id, &artifacts)
                .expect_err("traversal"),
            TestArtifactStoreError::InvalidArtifact
        );
    }

    #[test]
    fn store_revalidates_result_artifact_metadata_before_persisting() {
        let (_fixture, store) = fixture_store();
        let plan = navigate_plan(Uuid::new_v4(), Uuid::new_v4());
        let manifest = store.begin(&plan).expect("begin run");
        let mut result =
            synthetic_failure_result(&plan, &manifest, &BrowserJourneyFailure::InvalidResult);
        result.artifacts.push(ArtifactMetadata {
            artifact_id: "artifact-000".to_owned(),
            kind: ArtifactKind::Trace,
            relative_path: "../outside.zip".to_owned(),
            display_path: "/outside.zip".to_owned(),
            bytes: 0,
            sha256: sha256_bytes(b""),
        });

        assert_eq!(
            store
                .write_result(&result)
                .expect_err("unsafe result metadata"),
            TestArtifactStoreError::InvalidArtifact
        );
        assert!(store.read(plan.run_id).expect("read").is_none());
    }

    #[test]
    fn list_checks_record_digests_and_read_deep_hashes_artifacts() {
        let (_fixture, store) = fixture_store();
        let plan = screenshot_plan(Uuid::new_v4(), Uuid::new_v4());
        let manifest = store.begin(&plan).expect("begin run");
        let run_dir = store
            .run_directory(plan.run_id)
            .expect("run directory")
            .expect("run exists");
        let screenshot = run_dir.join("evidence.png");
        fs::write(&screenshot, b"good").expect("artifact");
        let completed_at_unix_ms = manifest.summary.started_at_unix_ms + 1;
        let artifact = ArtifactMetadata {
            artifact_id: "artifact-000".to_owned(),
            kind: ArtifactKind::Screenshot,
            relative_path: "evidence.png".to_owned(),
            display_path: path_to_display(&screenshot).expect("display path"),
            bytes: 4,
            sha256: sha256_bytes(b"good"),
        };
        let result = TestRunResult {
            schema_version: TEST_RUN_SCHEMA_VERSION,
            run_id: plan.run_id,
            workspace_id: plan.workspace_id,
            journey_id: plan.journey_id.clone(),
            state: TestRunState::Passed,
            started_at_unix_ms: manifest.summary.started_at_unix_ms,
            completed_at_unix_ms,
            duration_ms: 1,
            steps: vec![TestStepResult {
                step_id: plan.steps[0].id.clone(),
                label: plan.steps[0].label.clone(),
                kind: "screenshot".to_owned(),
                state: TestStepState::Passed,
                started_at_unix_ms: manifest.summary.started_at_unix_ms,
                completed_at_unix_ms,
                duration_ms: 1,
                snapshot_artifact_id: None,
                screenshot_artifact_id: Some(artifact.artifact_id.clone()),
                error: None,
            }],
            console_errors: Vec::new(),
            requests: Vec::new(),
            artifacts: vec![artifact],
            failure: None,
            graph_sha256: None,
        };
        store.finalize(&result).expect("finalize run");

        fs::write(&screenshot, b"evil").expect("same-size artifact tamper");
        assert_eq!(store.list().expect("cheap validated list").len(), 1);
        assert_eq!(
            store.read(plan.run_id).expect_err("deep artifact hash"),
            TestArtifactStoreError::InvalidArtifact
        );

        fs::write(&screenshot, b"good").expect("restore artifact");
        let result_path = run_dir.join(RESULT_FILE);
        let mut result_bytes = fs::read(&result_path).expect("result bytes");
        result_bytes.push(b'\n');
        fs::write(&result_path, result_bytes).expect("tamper result bytes");
        assert_eq!(
            store.list().expect_err("result digest mismatch"),
            TestArtifactStoreError::InvalidData
        );
    }

    #[test]
    fn list_rejects_a_tampered_journey_plan() {
        let (_fixture, store) = fixture_store();
        let plan = navigate_plan(Uuid::new_v4(), Uuid::new_v4());
        store.begin(&plan).expect("begin run");
        let run_dir = store
            .run_directory(plan.run_id)
            .expect("run directory")
            .expect("run exists");
        let journey_path = run_dir.join(JOURNEY_FILE);
        let mut plan_bytes = fs::read(&journey_path).expect("plan bytes");
        plan_bytes.push(b'\n');
        fs::write(journey_path, plan_bytes).expect("tamper plan bytes");

        assert_eq!(
            store.list().expect_err("plan digest mismatch"),
            TestArtifactStoreError::InvalidData
        );
    }

    #[test]
    fn process_adapter_hashes_only_declared_run_artifacts_and_finalizes() {
        let (fixture, store) = fixture_store();
        let plan = screenshot_plan(Uuid::new_v4(), Uuid::new_v4())
            .with_graph_sha256("b".repeat(64))
            .expect("graph digest");
        let output = json!({
            "schemaVersion": 1,
            "status": "passed",
            "times": {"startedAtUnixMs": 1, "completedAtUnixMs": 2},
            "duration": 1,
            "steps": [{
                "index": 0,
                "kind": "screenshot",
                "status": "passed",
                "startedAtUnixMs": 1,
                "completedAtUnixMs": 2,
                "duration": 1,
                "snapshot": null,
                "screenshot": "shot.png",
                "error": null
            }],
            "consoleErrors": [],
            "requests": [],
            "failure": null,
            "artifacts": {
                "trace": null,
                "failureScreenshot": null,
                "stepSnapshots": [],
                "screenshots": ["shot.png"]
            }
        });
        let script = format!(
            "#!/bin/sh\nprintf '%s' image > \"$4/shot.png\"\nprintf '%s' '{}' > \"$6\"\n",
            output
        );
        let helper = write_helper(&fixture, "success.sh", &script);
        let adapter =
            ProcessBrowserJourneyAdapter::new(&shell(), &helper).expect("process adapter");

        let result = adapter.run(&plan, &store).expect("journey result");

        assert_eq!(result.state, TestRunState::Passed);
        assert_eq!(result.artifacts.len(), 1);
        assert_eq!(result.artifacts[0].sha256, sha256_bytes(b"image"));
        assert_eq!(result.graph_sha256, Some("b".repeat(64)));
        let manifest = store
            .read_manifest(plan.run_id)
            .expect("manifest")
            .expect("manifest exists");
        assert_eq!(manifest.summary.state, TestRunState::Passed);
        assert_eq!(manifest.summary.passed_steps, 1);
        assert_eq!(manifest.summary.total_steps, 1);
        assert_eq!(
            store
                .read(plan.run_id)
                .expect("read result")
                .expect("result exists"),
            result
        );
        let run_dir = store
            .run_directory(plan.run_id)
            .expect("run directory")
            .expect("existing run");
        fs::write(run_dir.join(RESULT_FILE), b"{}").expect("tamper result");
        assert_eq!(
            store.read(plan.run_id).expect_err("result digest mismatch"),
            TestArtifactStoreError::InvalidData
        );
    }

    #[test]
    fn exit_one_is_a_valid_failed_journey_and_exit_two_is_infrastructure_failure() {
        let failed_output = json!({
            "schemaVersion": 1,
            "status": "failed",
            "times": {"startedAtUnixMs": 1, "completedAtUnixMs": 2},
            "duration": 1,
            "steps": [{
                "index": 0,
                "kind": "navigate",
                "status": "failed",
                "startedAtUnixMs": 1,
                "completedAtUnixMs": 2,
                "duration": 1,
                "snapshot": null,
                "screenshot": null,
                "error": "Expected help content"
            }],
            "consoleErrors": [],
            "requests": [{
                "method": "GET",
                "url": "http://127.0.0.1:41000/help?token=secret",
                "status": 500,
                "failure": "connection reset"
            }],
            "failure": {
                "stepIndex": 0,
                "kind": "navigate",
                "name": "AssertionError",
                "message": "Expected help content"
            },
            "artifacts": {
                "trace": null,
                "failureScreenshot": null,
                "stepSnapshots": [],
                "screenshots": []
            }
        });

        let (fixture, store) = fixture_store();
        let plan = navigate_plan(Uuid::new_v4(), Uuid::new_v4());
        let failed_script = format!(
            "#!/bin/sh\nprintf '%s' '{}' > \"$6\"\nexit 1\n",
            failed_output
        );
        let helper = write_helper(&fixture, "failed.sh", &failed_script);
        let adapter =
            ProcessBrowserJourneyAdapter::new(&shell(), &helper).expect("process adapter");
        let result = adapter
            .run(&plan, &store)
            .expect("a red assertion is a valid result");
        assert_eq!(result.state, TestRunState::Failed);
        assert_eq!(result.requests[0].url, "/help");
        assert_eq!(
            result
                .failure
                .as_ref()
                .and_then(|failure| failure.failed_step_id.as_deref()),
            Some("open-help")
        );

        let (fixture, store) = fixture_store();
        let plan = navigate_plan(Uuid::new_v4(), Uuid::new_v4());
        let invalid_input_script = format!(
            "#!/bin/sh\nprintf '%s' '{}' > \"$6\"\nexit 2\n",
            failed_output
        );
        let helper = write_helper(&fixture, "invalid-input.sh", &invalid_input_script);
        let adapter =
            ProcessBrowserJourneyAdapter::new(&shell(), &helper).expect("process adapter");
        assert_eq!(
            adapter.run(&plan, &store).expect_err("exit two"),
            BrowserJourneyFailure::HelperFailed
        );
        assert_eq!(
            store
                .read_manifest(plan.run_id)
                .expect("manifest")
                .expect("manifest exists")
                .summary
                .state,
            TestRunState::Failed
        );
    }

    #[test]
    fn invalid_helper_output_is_durable_failed_state() {
        let (fixture, store) = fixture_store();
        let plan = navigate_plan(Uuid::new_v4(), Uuid::new_v4());
        let helper = write_helper(
            &fixture,
            "invalid.sh",
            "#!/bin/sh\nprintf '%s' '{}' > \"$6\"\n",
        );
        let adapter =
            ProcessBrowserJourneyAdapter::new(&shell(), &helper).expect("process adapter");

        assert_eq!(
            adapter.run(&plan, &store).expect_err("invalid result"),
            BrowserJourneyFailure::InvalidResult
        );
        let manifest = store
            .read_manifest(plan.run_id)
            .expect("manifest")
            .expect("manifest exists");
        assert_eq!(manifest.summary.state, TestRunState::Failed);
        assert_eq!(
            manifest.summary.message.as_deref(),
            Some("browser helper result violated the strict contract")
        );
        assert_eq!(
            store
                .read(plan.run_id)
                .expect("read result")
                .expect("terminal result")
                .state,
            TestRunState::Failed
        );
    }

    #[test]
    fn output_overflow_terminates_helper_and_finalizes_failure() {
        let (fixture, store) = fixture_store();
        let plan = navigate_plan(Uuid::new_v4(), Uuid::new_v4());
        let helper = write_helper(
            &fixture,
            "overflow.sh",
            "#!/bin/sh\nwhile :; do printf '0123456789abcdef'; done\n",
        );
        let adapter = ProcessBrowserJourneyAdapter::new(&shell(), &helper)
            .expect("process adapter")
            .with_stream_limit(64);

        assert_eq!(
            adapter.run(&plan, &store).expect_err("overflow"),
            BrowserJourneyFailure::OutputTooLarge
        );
        assert_eq!(
            store
                .read_manifest(plan.run_id)
                .expect("manifest")
                .expect("manifest exists")
                .summary
                .state,
            TestRunState::Failed
        );
    }

    #[cfg(unix)]
    #[test]
    fn normal_helper_exit_reaps_orphaned_descendants() {
        let (fixture, store) = fixture_store();
        let plan = navigate_plan(Uuid::new_v4(), Uuid::new_v4());
        let output = json!({
            "schemaVersion": 1,
            "status": "passed",
            "times": {"startedAtUnixMs": 1, "completedAtUnixMs": 2},
            "duration": 1,
            "steps": [{
                "index": 0,
                "kind": "navigate",
                "status": "passed",
                "startedAtUnixMs": 1,
                "completedAtUnixMs": 2,
                "duration": 1,
                "snapshot": null,
                "screenshot": null,
                "error": null
            }],
            "consoleErrors": [],
            "requests": [],
            "failure": null,
            "artifacts": {
                "trace": null,
                "failureScreenshot": null,
                "stepSnapshots": [],
                "screenshots": []
            }
        });
        let script = format!(
            "#!/bin/sh\nsleep 30 </dev/null >/dev/null 2>&1 &\nprintf '%s' \"$!\" > \"$4/descendant.pid\"\nprintf '%s' '{}' > \"$6\"\n",
            output
        );
        let helper = write_helper(&fixture, "orphan.sh", &script);
        let adapter =
            ProcessBrowserJourneyAdapter::new(&shell(), &helper).expect("process adapter");

        let result = adapter.run(&plan, &store).expect("valid helper result");

        assert_eq!(result.state, TestRunState::Passed);
        let run_dir = store
            .run_directory(plan.run_id)
            .expect("run dir")
            .expect("exists");
        let descendant = wait_for_pid(&run_dir.join("descendant.pid"));
        assert_process_gone(descendant, "normal helper exit");
    }

    #[cfg(unix)]
    #[test]
    fn timeout_terminates_descendant_group_and_finalizes_timed_out() {
        let (fixture, store) = fixture_store();
        let plan = navigate_plan(Uuid::new_v4(), Uuid::new_v4());
        let helper = write_helper(
            &fixture,
            "timeout.sh",
            "#!/bin/sh\nsleep 30 & descendant=$!\nprintf '%s' \"$descendant\" > \"$4/descendant.pid\"\nwait\n",
        );
        let adapter = ProcessBrowserJourneyAdapter::new(&shell(), &helper)
            .expect("process adapter")
            .with_process_grace(Duration::from_millis(100));

        assert_eq!(
            adapter.run(&plan, &store).expect_err("timeout"),
            BrowserJourneyFailure::TimedOut
        );
        let run_dir = store
            .run_directory(plan.run_id)
            .expect("run dir")
            .expect("exists");
        let descendant = wait_for_pid(&run_dir.join("descendant.pid"));
        assert_process_gone(descendant, "timeout");
        assert_eq!(
            store
                .read_manifest(plan.run_id)
                .expect("manifest")
                .expect("manifest exists")
                .summary
                .state,
            TestRunState::TimedOut
        );
    }

    #[test]
    fn fake_adapter_can_share_the_public_persistence_contract() {
        struct FakeAdapter;

        impl BrowserJourneyAdapter for FakeAdapter {
            fn run(
                &self,
                plan: &JourneyPlan,
                store: &TestArtifactStore,
            ) -> Result<TestRunResult, BrowserJourneyFailure> {
                let manifest = store.begin(plan).map_err(BrowserJourneyFailure::Store)?;
                let completed_at_unix_ms = manifest.summary.started_at_unix_ms + 1;
                let result = TestRunResult {
                    schema_version: TEST_RUN_SCHEMA_VERSION,
                    run_id: plan.run_id,
                    workspace_id: plan.workspace_id,
                    journey_id: plan.journey_id.clone(),
                    state: TestRunState::Passed,
                    started_at_unix_ms: manifest.summary.started_at_unix_ms,
                    completed_at_unix_ms,
                    duration_ms: 1,
                    steps: vec![TestStepResult {
                        step_id: plan.steps[0].id.clone(),
                        label: plan.steps[0].label.clone(),
                        kind: step_kind_name(plan.steps[0].action.kind()).to_owned(),
                        state: TestStepState::Passed,
                        started_at_unix_ms: manifest.summary.started_at_unix_ms,
                        completed_at_unix_ms,
                        duration_ms: 1,
                        snapshot_artifact_id: None,
                        screenshot_artifact_id: None,
                        error: None,
                    }],
                    console_errors: Vec::new(),
                    requests: Vec::new(),
                    artifacts: Vec::new(),
                    failure: None,
                    graph_sha256: plan.graph_sha256.clone(),
                };
                store
                    .finalize(&result)
                    .map_err(BrowserJourneyFailure::Store)?;
                Ok(result)
            }
        }

        let (_fixture, store) = fixture_store();
        let plan = navigate_plan(Uuid::new_v4(), Uuid::new_v4());
        let result = FakeAdapter.run(&plan, &store).expect("fake result");
        assert_eq!(result.state, TestRunState::Passed);
        assert_eq!(store.list().expect("list").len(), 1);
    }

    #[cfg(unix)]
    fn wait_for_pid(path: &Path) -> i32 {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if let Ok(value) = fs::read_to_string(path)
                && let Ok(process_id) = value.parse::<i32>()
            {
                return process_id;
            }
            assert!(Instant::now() < deadline, "descendant PID not published");
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[cfg(unix)]
    fn assert_process_gone(process_id: i32, context: &str) {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            // SAFETY: signal zero performs only a process-existence check.
            let alive = unsafe { libc::kill(process_id, 0) } == 0;
            if !alive && io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "browser helper descendant survived {context}"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }
}
