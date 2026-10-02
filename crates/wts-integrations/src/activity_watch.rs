use crate::jira_mcp::JiraActiveIssue;
use reqwest::{
    Url,
    blocking::{Client, Response},
    redirect::Policy,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeSet, HashMap},
    fmt,
    io::{self, Read},
    net::IpAddr,
    time::Duration,
};

pub const WTS_ACTIVITYWATCH_URL_ENV: &str = "WTS_ACTIVITYWATCH_URL";
pub const DEFAULT_ACTIVITYWATCH_URL: &str = "http://127.0.0.1:5600";

const CONNECT_TIMEOUT: Duration = Duration::from_millis(500);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(2);
/// A daily review reads a full day of events per bucket. A cold ActivityWatch
/// database can take several seconds, so review reads get a longer limit than
/// the quick status check.
const REVIEW_REQUEST_TIMEOUT: Duration = Duration::from_secs(12);
const MAX_RESPONSE_BYTES: usize = 16 * 1024;
const MAX_VERSION_BYTES: usize = 128;
const MAX_REVIEW_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_REVIEW_BUCKETS: usize = 64;
const MAX_REVIEW_EVENTS: usize = 10_000;
const MAX_REVIEW_WINDOW_MILLISECONDS: i64 = 48 * 60 * 60 * 1_000;
const TRANSIENT_SESSION_SECONDS: u64 = 30;
const MAX_REVIEW_SESSION_SPAN_MILLISECONDS: i64 = 30 * 60 * 1_000;
const MAX_REVIEW_SESSION_IDLE_GAP_MILLISECONDS: i64 = 5 * 60 * 1_000;
const MAX_APPLICATION_EVIDENCE_CHARACTERS: usize = 48;
const MAX_CONTEXT_EVIDENCE_CHARACTERS: usize = 120;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ActivityWatchState {
    Running,
    Unavailable,
    Incompatible,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ActivityWatchInstallation {
    Detected,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ActivityWatchCapability {
    Status,
    DailyReview,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ActivityWatchDiagnosticCode {
    ConnectionFailed,
    RequestTimedOut,
    ResponseTooLarge,
    ResponseInvalid,
    ServerRejected,
}

/// Privacy-safe status for the local ActivityWatch API.
///
/// This contract deliberately excludes buckets, events, host names, window
/// titles, URLs, and response bodies. `installation` is `unknown` when the
/// API cannot prove that ActivityWatch is installed; an unreachable endpoint
/// cannot distinguish "not installed" from "installed but not running".
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActivityWatchStatus {
    pub state: ActivityWatchState,
    pub installation: ActivityWatchInstallation,
    pub endpoint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_version: Option<String>,
    pub capabilities: Vec<ActivityWatchCapability>,
    pub detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostic_code: Option<ActivityWatchDiagnosticCode>,
}

/// Stable configuration failures. No variant retains a configured URL or
/// response body, so errors are safe to cross IPC and enter development logs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActivityWatchError {
    InvalidEndpoint,
    ClientInitializationFailed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActivityWatchReviewError {
    InvalidTimeRange,
    ConnectionFailed,
    RequestTimedOut,
    ResponseTooLarge,
    ResponseInvalid,
    EndpointRedirected,
    ServerRejected,
}

impl ActivityWatchReviewError {
    pub const fn safe_message(self) -> &'static str {
        match self {
            Self::InvalidTimeRange => {
                "Choose an ActivityWatch review window after the start time and no longer than 48 hours."
            }
            Self::ConnectionFailed => "Could not reach ActivityWatch on the local endpoint.",
            Self::RequestTimedOut => "ActivityWatch did not answer within the local read timeout.",
            Self::ResponseTooLarge => {
                "ActivityWatch returned too much activity to review at one time."
            }
            Self::ResponseInvalid => {
                "ActivityWatch returned an invalid response for the requested review."
            }
            Self::EndpointRedirected => {
                "ActivityWatch redirected a local API request. Use the canonical loopback endpoint."
            }
            Self::ServerRejected => "ActivityWatch rejected the local review request.",
        }
    }
}

impl fmt::Display for ActivityWatchReviewError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.safe_message())
    }
}

impl std::error::Error for ActivityWatchReviewError {}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ActivityWatchSessionKind {
    Coding,
    Agent,
    Browser,
    Communication,
    Terminal,
    Other,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActivityWatchSessionCandidate {
    pub id: String,
    pub kind: ActivityWatchSessionKind,
    pub started_at_unix_ms: i64,
    pub ended_at_unix_ms: i64,
    pub duration_seconds: u64,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub application: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activity_evidence: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jira_issue_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggested_jira_issue_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jira_suggestion_confidence: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jira_suggestion_reason: Option<String>,
    pub source_event_count: usize,
}

/// A privacy-bounded, review-only projection of local ActivityWatch events.
///
/// Raw URLs, file paths, email addresses, bucket identifiers, and event
/// payloads never cross this contract. Useful sanitized labels do, so a user
/// can understand and review the derived work blocks.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActivityWatchDailyReview {
    pub schema_version: u8,
    pub started_at_unix_ms: i64,
    pub ended_at_unix_ms: i64,
    pub total_active_seconds: u64,
    pub sessions: Vec<ActivityWatchSessionCandidate>,
    pub detail: String,
}

impl ActivityWatchError {
    pub const fn safe_message(self) -> &'static str {
        match self {
            Self::InvalidEndpoint => {
                "The ActivityWatch endpoint must be an HTTP URL using a numeric loopback address."
            }
            Self::ClientInitializationFailed => {
                "Could not initialize the local ActivityWatch connector."
            }
        }
    }
}

impl fmt::Display for ActivityWatchError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.safe_message())
    }
}

impl std::error::Error for ActivityWatchError {}

#[derive(Clone)]
pub struct ActivityWatchConnector {
    client: Client,
    origin: Url,
    display_origin: String,
    max_response_bytes: usize,
    review_timeout: Duration,
}

impl fmt::Debug for ActivityWatchConnector {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ActivityWatchConnector")
            .field("origin", &self.display_origin)
            .finish_non_exhaustive()
    }
}

impl ActivityWatchConnector {
    pub fn configured(endpoint: Option<&str>) -> Result<Self, ActivityWatchError> {
        let configured = endpoint
            .map(str::to_owned)
            .or_else(|| std::env::var(WTS_ACTIVITYWATCH_URL_ENV).ok())
            .unwrap_or_else(|| DEFAULT_ACTIVITYWATCH_URL.to_owned());
        Self::new(&configured)
    }

    pub fn new(endpoint: &str) -> Result<Self, ActivityWatchError> {
        Self::with_limits(
            endpoint,
            CONNECT_TIMEOUT,
            REQUEST_TIMEOUT,
            MAX_RESPONSE_BYTES,
        )
    }

    fn with_limits(
        endpoint: &str,
        connect_timeout: Duration,
        request_timeout: Duration,
        max_response_bytes: usize,
    ) -> Result<Self, ActivityWatchError> {
        let origin = validate_origin(endpoint)?;
        let display_origin = origin.origin().ascii_serialization();
        let client = Client::builder()
            .connect_timeout(connect_timeout)
            .timeout(request_timeout)
            .redirect(Policy::none())
            .user_agent("WTS ActivityWatch connector")
            .build()
            .map_err(|_| ActivityWatchError::ClientInitializationFailed)?;
        Ok(Self {
            client,
            origin,
            display_origin,
            max_response_bytes,
            review_timeout: REVIEW_REQUEST_TIMEOUT.max(request_timeout),
        })
    }

    #[cfg(test)]
    fn with_review_timeout(mut self, review_timeout: Duration) -> Self {
        self.review_timeout = review_timeout;
        self
    }

    pub fn status(&self) -> ActivityWatchStatus {
        let endpoint = match self.info_endpoint() {
            Ok(endpoint) => endpoint,
            Err(()) => return self.incompatible(ActivityWatchDiagnosticCode::ResponseInvalid),
        };
        let response = match self
            .client
            .get(endpoint)
            .header(reqwest::header::ACCEPT, "application/json")
            .send()
        {
            Ok(response) => response,
            Err(error) => {
                let diagnostic = if error.is_timeout() {
                    ActivityWatchDiagnosticCode::RequestTimedOut
                } else {
                    ActivityWatchDiagnosticCode::ConnectionFailed
                };
                return self.unavailable(diagnostic);
            }
        };
        if !response.status().is_success() {
            return self.incompatible(ActivityWatchDiagnosticCode::ServerRejected);
        }
        let body = match read_bounded(response, self.max_response_bytes) {
            Ok(body) => body,
            Err(ReadFailure::TooLarge) => {
                return self.incompatible(ActivityWatchDiagnosticCode::ResponseTooLarge);
            }
            Err(ReadFailure::Io) => {
                return self.incompatible(ActivityWatchDiagnosticCode::ResponseInvalid);
            }
        };
        let info: ActivityWatchInfo = match serde_json::from_slice(&body) {
            Ok(info) => info,
            Err(_) => return self.incompatible(ActivityWatchDiagnosticCode::ResponseInvalid),
        };
        if !valid_version(&info.version) {
            return self.incompatible(ActivityWatchDiagnosticCode::ResponseInvalid);
        }

        ActivityWatchStatus {
            state: ActivityWatchState::Running,
            installation: ActivityWatchInstallation::Detected,
            endpoint: self.display_origin.clone(),
            api_version: Some("v0".to_owned()),
            server_version: Some(info.version),
            capabilities: vec![
                ActivityWatchCapability::Status,
                ActivityWatchCapability::DailyReview,
            ],
            detail: "ActivityWatch is running locally. Activity is read only when you build a daily review."
                .to_owned(),
            diagnostic_code: None,
        }
    }

    pub fn daily_review(
        &self,
        started_at_unix_ms: i64,
        ended_at_unix_ms: i64,
    ) -> Result<ActivityWatchDailyReview, ActivityWatchReviewError> {
        self.daily_review_with_jira_issues(started_at_unix_ms, ended_at_unix_ms, &[])
    }

    pub fn daily_review_with_jira_issues(
        &self,
        started_at_unix_ms: i64,
        ended_at_unix_ms: i64,
        jira_issues: &[JiraActiveIssue],
    ) -> Result<ActivityWatchDailyReview, ActivityWatchReviewError> {
        if started_at_unix_ms < 0
            || ended_at_unix_ms <= started_at_unix_ms
            || ended_at_unix_ms.saturating_sub(started_at_unix_ms) > MAX_REVIEW_WINDOW_MILLISECONDS
        {
            return Err(ActivityWatchReviewError::InvalidTimeRange);
        }
        let start = unix_milliseconds_to_rfc3339(started_at_unix_ms)
            .ok_or(ActivityWatchReviewError::InvalidTimeRange)?;
        let end = unix_milliseconds_to_rfc3339(ended_at_unix_ms)
            .ok_or(ActivityWatchReviewError::InvalidTimeRange)?;

        let buckets_endpoint = self
            .origin
            // ActivityWatch canonicalizes this collection with a trailing
            // slash. Redirects stay disabled so a local integration can never
            // hand WTS off to another origin.
            .join("/api/0/buckets/")
            .map_err(|_| ActivityWatchReviewError::ResponseInvalid)?;
        let buckets: HashMap<String, ActivityWatchBucket> =
            self.get_json(buckets_endpoint, MAX_REVIEW_RESPONSE_BYTES)?;
        if buckets.len() > MAX_REVIEW_BUCKETS {
            return Err(ActivityWatchReviewError::ResponseTooLarge);
        }

        let mut activities = Vec::new();
        let mut afk_intervals = Vec::new();
        let mut event_count = 0usize;
        let mut ordered_buckets = buckets.into_values().collect::<Vec<_>>();
        ordered_buckets.sort_by(|left, right| left.id.cmp(&right.id));
        for bucket in ordered_buckets {
            let Some(source) = ActivitySource::from_bucket_type(&bucket.bucket_type) else {
                continue;
            };
            let mut endpoint = self.origin.clone();
            {
                let mut segments = endpoint
                    .path_segments_mut()
                    .map_err(|_| ActivityWatchReviewError::ResponseInvalid)?;
                segments.clear();
                segments.extend(["api", "0", "buckets", &bucket.id, "events"]);
            }
            endpoint
                .query_pairs_mut()
                .append_pair("start", &start)
                .append_pair("end", &end)
                .append_pair("limit", "-1");
            let events: Vec<ActivityWatchEvent> =
                self.get_json(endpoint, MAX_REVIEW_RESPONSE_BYTES)?;
            event_count = event_count.saturating_add(events.len());
            if event_count > MAX_REVIEW_EVENTS {
                return Err(ActivityWatchReviewError::ResponseTooLarge);
            }
            for event in events {
                let Some((event_start, event_end)) = event.bounds() else {
                    continue;
                };
                if source == ActivitySource::Afk {
                    if event
                        .data
                        .get("status")
                        .and_then(serde_json::Value::as_str)
                        .is_some_and(|status| status.eq_ignore_ascii_case("afk"))
                    {
                        afk_intervals.push((event_start, event_end));
                    }
                    continue;
                }
                activities.push(DerivedActivity::from_event(
                    source,
                    event_start,
                    event_end,
                    &event.data,
                    jira_issues,
                ));
            }
        }

        let sessions = sessionize(
            activities,
            afk_intervals,
            started_at_unix_ms,
            ended_at_unix_ms,
        );
        let total_active_seconds = sessions
            .iter()
            .map(|session| session.duration_seconds)
            .sum();
        Ok(ActivityWatchDailyReview {
            schema_version: 1,
            started_at_unix_ms,
            ended_at_unix_ms,
            total_active_seconds,
            sessions,
            detail: "Derived locally for review. Raw ActivityWatch titles, URLs, paths, and event payloads were not retained."
                .to_owned(),
        })
    }

    fn get_json<T: for<'de> Deserialize<'de>>(
        &self,
        endpoint: Url,
        maximum_bytes: usize,
    ) -> Result<T, ActivityWatchReviewError> {
        let response = self
            .client
            .get(endpoint)
            .timeout(self.review_timeout)
            .header(reqwest::header::ACCEPT, "application/json")
            .send()
            .map_err(|error| {
                if error.is_timeout() {
                    ActivityWatchReviewError::RequestTimedOut
                } else {
                    ActivityWatchReviewError::ConnectionFailed
                }
            })?;
        if response.status().is_redirection() {
            return Err(ActivityWatchReviewError::EndpointRedirected);
        }
        if !response.status().is_success() {
            return Err(ActivityWatchReviewError::ServerRejected);
        }
        let body = read_bounded(response, maximum_bytes).map_err(|failure| match failure {
            ReadFailure::TooLarge => ActivityWatchReviewError::ResponseTooLarge,
            ReadFailure::Io => ActivityWatchReviewError::ResponseInvalid,
        })?;
        serde_json::from_slice(&body).map_err(|_| ActivityWatchReviewError::ResponseInvalid)
    }

    fn info_endpoint(&self) -> Result<Url, ()> {
        self.origin.join("/api/0/info").map_err(|_| ())
    }

    fn unavailable(&self, diagnostic_code: ActivityWatchDiagnosticCode) -> ActivityWatchStatus {
        ActivityWatchStatus {
            state: ActivityWatchState::Unavailable,
            installation: ActivityWatchInstallation::Unknown,
            endpoint: self.display_origin.clone(),
            api_version: None,
            server_version: None,
            capabilities: vec![],
            detail: "Could not reach ActivityWatch locally. Installation cannot be determined from the API."
                .to_owned(),
            diagnostic_code: Some(diagnostic_code),
        }
    }

    fn incompatible(&self, diagnostic_code: ActivityWatchDiagnosticCode) -> ActivityWatchStatus {
        ActivityWatchStatus {
            state: ActivityWatchState::Incompatible,
            installation: ActivityWatchInstallation::Unknown,
            endpoint: self.display_origin.clone(),
            api_version: None,
            server_version: None,
            capabilities: vec![],
            detail:
                "The local endpoint did not return a compatible ActivityWatch API v0 status response."
                    .to_owned(),
            diagnostic_code: Some(diagnostic_code),
        }
    }
}

#[derive(Deserialize)]
struct ActivityWatchBucket {
    id: String,
    #[serde(rename = "type")]
    bucket_type: String,
}

#[derive(Deserialize)]
struct ActivityWatchEvent {
    timestamp: String,
    duration: f64,
    #[serde(default)]
    data: HashMap<String, serde_json::Value>,
}

impl ActivityWatchEvent {
    fn bounds(&self) -> Option<(i64, i64)> {
        if !self.duration.is_finite() || self.duration <= 0.0 {
            return None;
        }
        let start = parse_rfc3339_milliseconds(&self.timestamp)?;
        let duration_ms = (self.duration * 1_000.0).round() as i64;
        Some((start, start.saturating_add(duration_ms)))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ActivitySource {
    Window,
    Browser,
    Editor,
    Afk,
}

impl ActivitySource {
    fn from_bucket_type(bucket_type: &str) -> Option<Self> {
        let normalized = bucket_type.to_ascii_lowercase();
        if normalized.contains("afkstatus") {
            Some(Self::Afk)
        } else if normalized.contains("currentwindow") {
            Some(Self::Window)
        } else if normalized.contains("web.tab") {
            Some(Self::Browser)
        } else if normalized.contains("editor") {
            Some(Self::Editor)
        } else {
            None
        }
    }
}

#[derive(Clone, Debug)]
struct DerivedActivity {
    start: i64,
    end: i64,
    kind: ActivityWatchSessionKind,
    description: String,
    application: Option<String>,
    activity_evidence: Option<String>,
    jira_issue_key: Option<String>,
    suggested_jira_issue_key: Option<String>,
    jira_suggestion_confidence: Option<u8>,
    jira_suggestion_reason: Option<String>,
    priority: u8,
}

impl DerivedActivity {
    fn from_event(
        source: ActivitySource,
        start: i64,
        end: i64,
        data: &HashMap<String, serde_json::Value>,
        jira_issues: &[JiraActiveIssue],
    ) -> Self {
        let app = data
            .get("app")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        let title = data
            .get("title")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        let url = data
            .get("url")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        let project = data
            .get("project")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        let searchable = format!("{app} {title} {url} {project}");
        let jira_issue_key = find_jira_issue_key(&searchable);
        let semantic_context = format!("{title} {project}");
        let semantic_suggestion = jira_issue_key
            .is_none()
            .then(|| semantic_jira_suggestion(&semantic_context, jira_issues))
            .flatten();
        let activity_evidence = sanitize_context_evidence(title, project);
        let lowered = searchable.to_ascii_lowercase();
        let kind = if contains_any(&lowered, &["codex", "opencode", "hermes"]) {
            ActivityWatchSessionKind::Agent
        } else {
            match source {
                ActivitySource::Editor => ActivityWatchSessionKind::Coding,
                ActivitySource::Browser => ActivityWatchSessionKind::Browser,
                ActivitySource::Window
                    if contains_any(
                        &lowered,
                        &["code", "visual studio", "intellij", "pycharm", "xcode"],
                    ) =>
                {
                    ActivityWatchSessionKind::Coding
                }
                ActivitySource::Window
                    if contains_any(
                        &lowered,
                        &[
                            "arc browser",
                            "brave browser",
                            "firefox",
                            "google chrome",
                            "microsoft edge",
                            "safari",
                        ],
                    ) =>
                {
                    ActivityWatchSessionKind::Browser
                }
                ActivitySource::Window
                    if contains_any(&lowered, &["warp", "terminal", "iterm"]) =>
                {
                    ActivityWatchSessionKind::Terminal
                }
                ActivitySource::Window if contains_any(&lowered, &["slack", "teams", "zoom"]) => {
                    ActivityWatchSessionKind::Communication
                }
                _ => ActivityWatchSessionKind::Other,
            }
        };
        let application = sanitize_application(app, &kind);
        let description = match (&kind, jira_issue_key.as_deref()) {
            (ActivityWatchSessionKind::Coding, Some(key)) => format!("Coding work for {key}"),
            (ActivityWatchSessionKind::Agent, Some(key)) => {
                format!("Agent-assisted work for {key}")
            }
            (ActivityWatchSessionKind::Browser, Some(key)) => {
                format!("Browser research for {key}")
            }
            (ActivityWatchSessionKind::Communication, Some(key)) => {
                format!("Communication for {key}")
            }
            (ActivityWatchSessionKind::Terminal, Some(key)) => {
                format!("Terminal work for {key}")
            }
            (_, Some(key)) => format!("Work related to {key}"),
            (ActivityWatchSessionKind::Coding, None) => "Coding work".to_owned(),
            (ActivityWatchSessionKind::Agent, None) => "Agent-assisted work".to_owned(),
            (ActivityWatchSessionKind::Browser, None) => "Browser research".to_owned(),
            (ActivityWatchSessionKind::Communication, None) => "Communication".to_owned(),
            (ActivityWatchSessionKind::Terminal, None) => "Terminal work".to_owned(),
            (ActivityWatchSessionKind::Other, None) => "Other active work".to_owned(),
        };
        let priority = match kind {
            ActivityWatchSessionKind::Agent => 70,
            ActivityWatchSessionKind::Coding if source == ActivitySource::Editor => 60,
            ActivityWatchSessionKind::Coding => 50,
            ActivityWatchSessionKind::Terminal => 45,
            ActivityWatchSessionKind::Communication => 40,
            ActivityWatchSessionKind::Browser => 30,
            ActivityWatchSessionKind::Other => 20,
        };
        Self {
            start,
            end,
            kind,
            description,
            application,
            activity_evidence,
            jira_issue_key,
            suggested_jira_issue_key: semantic_suggestion
                .as_ref()
                .map(|suggestion| suggestion.0.clone()),
            jira_suggestion_confidence: semantic_suggestion.as_ref().map(|suggestion| suggestion.1),
            jira_suggestion_reason: semantic_suggestion.map(|suggestion| suggestion.2),
            priority,
        }
    }
}

fn sanitize_application(value: &str, kind: &ActivityWatchSessionKind) -> Option<String> {
    let lowered = value.to_ascii_lowercase();
    let canonical = [
        ("visual studio code", "Visual Studio Code"),
        ("google chrome", "Google Chrome"),
        ("microsoft edge", "Microsoft Edge"),
        ("brave browser", "Brave Browser"),
        ("intellij", "IntelliJ"),
        ("pycharm", "PyCharm"),
        ("firefox", "Firefox"),
        ("safari", "Safari"),
        ("slack", "Slack"),
        ("teams", "Microsoft Teams"),
        ("zoom", "Zoom"),
        ("warp", "Warp"),
        ("iterm", "iTerm"),
        ("terminal", "Terminal"),
        ("opencode", "OpenCode"),
        ("hermes", "Hermes"),
        ("codex", "Codex"),
    ];
    if let Some((_, label)) = canonical
        .iter()
        .find(|(needle, _)| lowered.contains(needle))
    {
        return Some((*label).to_owned());
    }
    let sanitized = sanitize_evidence(value, MAX_APPLICATION_EVIDENCE_CHARACTERS);
    if !sanitized.is_empty() {
        return Some(sanitized);
    }
    Some(
        match kind {
            ActivityWatchSessionKind::Coding => "Code editor",
            ActivityWatchSessionKind::Agent => "Agent",
            ActivityWatchSessionKind::Browser => "Browser",
            ActivityWatchSessionKind::Communication => "Communication app",
            ActivityWatchSessionKind::Terminal => "Terminal",
            ActivityWatchSessionKind::Other => return None,
        }
        .to_owned(),
    )
}

fn sanitize_context_evidence(title: &str, project: &str) -> Option<String> {
    let mut parts = Vec::new();
    for value in [title, project] {
        let sanitized = sanitize_evidence(value, MAX_CONTEXT_EVIDENCE_CHARACTERS);
        if !sanitized.is_empty() && !parts.contains(&sanitized) {
            parts.push(sanitized);
        }
    }
    let joined = truncate_characters(&parts.join(" · "), MAX_CONTEXT_EVIDENCE_CHARACTERS);
    (!joined.is_empty()).then_some(joined)
}

fn sanitize_evidence(value: &str, maximum_characters: usize) -> String {
    let mut kept = Vec::new();
    let mut redact_next = false;
    for raw_token in value.split_whitespace() {
        let raw_lowered = raw_token.to_ascii_lowercase();
        if raw_token.contains('@')
            || raw_lowered.starts_with("http://")
            || raw_lowered.starts_with("https://")
            || raw_lowered.starts_with("www.")
            || raw_lowered.starts_with("file://")
            || raw_lowered.starts_with('/')
            || raw_lowered.starts_with("~/")
            || looks_like_windows_path(raw_token)
            || looks_like_secret_assignment(&raw_lowered)
        {
            continue;
        }
        let token = raw_token.trim_matches(|character: char| {
            character.is_ascii_punctuation() && !matches!(character, '-' | '_' | '.')
        });
        if token.is_empty() {
            continue;
        }
        let lowered = token.to_ascii_lowercase();
        if redact_next {
            redact_next = false;
            continue;
        }
        if matches!(
            lowered.as_str(),
            "token" | "password" | "passwd" | "secret" | "authorization" | "api_key" | "apikey"
        ) {
            redact_next = true;
            continue;
        }
        if looks_like_file_name(token) {
            continue;
        }
        let clean = token
            .chars()
            .filter(|character| !character.is_control())
            .collect::<String>();
        if !clean.is_empty() {
            kept.push(clean);
        }
    }
    truncate_characters(&kept.join(" "), maximum_characters)
}

fn looks_like_windows_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/')
}

fn looks_like_secret_assignment(value: &str) -> bool {
    [
        "token=",
        "password=",
        "passwd=",
        "secret=",
        "authorization=",
        "api_key=",
        "apikey=",
    ]
    .iter()
    .any(|prefix| value.starts_with(prefix))
}

fn looks_like_file_name(value: &str) -> bool {
    let trimmed = value.trim_matches(|character: char| {
        matches!(
            character,
            '(' | ')' | '[' | ']' | '{' | '}' | ',' | ';' | ':'
        )
    });
    let Some((stem, extension)) = trimmed.rsplit_once('.') else {
        return false;
    };
    !stem.is_empty()
        && (1..=8).contains(&extension.len())
        && extension.bytes().all(|byte| byte.is_ascii_alphanumeric())
}

fn truncate_characters(value: &str, maximum_characters: usize) -> String {
    value.chars().take(maximum_characters).collect::<String>()
}

fn contains_any(value: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| value.contains(needle))
}

fn find_jira_issue_key(value: &str) -> Option<String> {
    for token in value.split(|character: char| {
        !character.is_ascii_alphanumeric() && character != '-' && character != '_'
    }) {
        let Some((project, number)) = token.rsplit_once('-') else {
            continue;
        };
        if project.len() >= 2
            && project
                .bytes()
                .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
            && !number.is_empty()
            && number.bytes().all(|byte| byte.is_ascii_digit())
        {
            return Some(token.to_owned());
        }
    }
    None
}

fn semantic_jira_suggestion(
    activity_context: &str,
    issues: &[JiraActiveIssue],
) -> Option<(String, u8, String)> {
    let activity_terms = matching_terms(activity_context);
    if activity_terms.len() < 2 {
        return None;
    }
    let mut candidates = issues
        .iter()
        .filter_map(|issue| {
            let summary_terms = matching_terms(&issue.summary);
            if summary_terms.len() < 2 {
                return None;
            }
            let overlap = activity_terms.intersection(&summary_terms).count();
            if overlap < 2 {
                return None;
            }
            let coverage = overlap.saturating_mul(100) / summary_terms.len();
            let confidence = (60 + overlap.saturating_mul(5) + coverage / 5).min(95) as u8;
            Some((issue.issue_key.clone(), confidence, overlap))
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        right
            .1
            .cmp(&left.1)
            .then_with(|| right.2.cmp(&left.2))
            .then_with(|| left.0.cmp(&right.0))
    });
    let best = candidates.first()?;
    if candidates
        .get(1)
        .is_some_and(|second| second.1 == best.1 && second.2 == best.2)
    {
        return None;
    }
    Some((
        best.0.clone(),
        best.1,
        format!(
            "Activity context matches {} distinctive words in the Jira summary",
            best.2
        ),
    ))
}

fn matching_terms(value: &str) -> BTreeSet<String> {
    value
        .split(|character: char| !character.is_ascii_alphanumeric())
        .map(str::to_ascii_lowercase)
        .filter(|term| {
            term.len() >= 4
                && term.bytes().any(|byte| byte.is_ascii_alphabetic())
                && !matches!(
                    term.as_str(),
                    "active"
                        | "activity"
                        | "application"
                        | "browser"
                        | "chrome"
                        | "coding"
                        | "current"
                        | "editor"
                        | "file"
                        | "google"
                        | "https"
                        | "issue"
                        | "jira"
                        | "other"
                        | "project"
                        | "slack"
                        | "terminal"
                        | "visual"
                        | "window"
                        | "work"
                        | "workspace"
                )
        })
        .collect()
}

fn sessionize(
    activities: Vec<DerivedActivity>,
    afk_intervals: Vec<(i64, i64)>,
    range_start: i64,
    range_end: i64,
) -> Vec<ActivityWatchSessionCandidate> {
    let mut boundaries = vec![range_start, range_end];
    for activity in &activities {
        boundaries.push(activity.start.max(range_start).min(range_end));
        boundaries.push(activity.end.max(range_start).min(range_end));
    }
    for (start, end) in &afk_intervals {
        boundaries.push((*start).max(range_start).min(range_end));
        boundaries.push((*end).max(range_start).min(range_end));
    }
    boundaries.sort_unstable();
    boundaries.dedup();

    let mut slices: Vec<(i64, i64, &DerivedActivity)> = Vec::new();
    for window in boundaries.windows(2) {
        let (start, end) = (window[0], window[1]);
        if end <= start {
            continue;
        }
        let midpoint = start + (end - start) / 2;
        if afk_intervals
            .iter()
            .any(|(afk_start, afk_end)| *afk_start <= midpoint && midpoint < *afk_end)
        {
            continue;
        }
        if let Some(activity) = activities
            .iter()
            .filter(|activity| activity.start <= midpoint && midpoint < activity.end)
            .max_by_key(|activity| activity.priority)
        {
            slices.push((start, end, activity));
        }
    }

    let mut sessions: Vec<ActivityWatchSessionCandidate> = Vec::new();
    for (start, end, activity) in slices {
        if let Some(previous) = sessions.last_mut()
            && previous.ended_at_unix_ms == start
            && previous.kind == activity.kind
            && previous.jira_issue_key == activity.jira_issue_key
            && previous.suggested_jira_issue_key == activity.suggested_jira_issue_key
            && previous.description == activity.description
            && previous.application == activity.application
            && previous.activity_evidence == activity.activity_evidence
        {
            previous.ended_at_unix_ms = end;
            previous.duration_seconds =
                ((previous.ended_at_unix_ms - previous.started_at_unix_ms) / 1_000) as u64;
            previous.source_event_count += 1;
            continue;
        }
        sessions.push(ActivityWatchSessionCandidate {
            id: String::new(),
            kind: activity.kind,
            started_at_unix_ms: start,
            ended_at_unix_ms: end,
            duration_seconds: ((end - start) / 1_000) as u64,
            description: activity.description.clone(),
            application: activity.application.clone(),
            activity_evidence: activity.activity_evidence.clone(),
            jira_issue_key: activity.jira_issue_key.clone(),
            suggested_jira_issue_key: activity.suggested_jira_issue_key.clone(),
            jira_suggestion_confidence: activity.jira_suggestion_confidence,
            jira_suggestion_reason: activity.jira_suggestion_reason.clone(),
            source_event_count: 1,
        });
    }
    sessions.retain(|session| session.duration_seconds > 0);
    collapse_transient_interruptions(&mut sessions);
    sessions = aggregate_review_sessions(sessions);
    for (index, session) in sessions.iter_mut().enumerate() {
        session.id = format!("aw-{:04}", index + 1);
    }
    sessions
}

fn aggregate_review_sessions(
    sessions: Vec<ActivityWatchSessionCandidate>,
) -> Vec<ActivityWatchSessionCandidate> {
    let mut aggregated = Vec::new();
    let mut chunk = Vec::new();
    for session in sessions {
        let should_flush = chunk
            .last()
            .is_some_and(|previous: &ActivityWatchSessionCandidate| {
                let first = &chunk[0];
                session
                    .started_at_unix_ms
                    .saturating_sub(previous.ended_at_unix_ms)
                    > MAX_REVIEW_SESSION_IDLE_GAP_MILLISECONDS
                    || session
                        .ended_at_unix_ms
                        .saturating_sub(first.started_at_unix_ms)
                        > MAX_REVIEW_SESSION_SPAN_MILLISECONDS
                    || jira_partition(first) != jira_partition(&session)
            });
        if should_flush {
            aggregated.push(aggregate_session_chunk(&chunk));
            chunk.clear();
        }
        chunk.push(session);
    }
    if !chunk.is_empty() {
        aggregated.push(aggregate_session_chunk(&chunk));
    }
    aggregated
}

fn jira_partition(session: &ActivityWatchSessionCandidate) -> (Option<&str>, Option<&str>) {
    (
        session.jira_issue_key.as_deref(),
        session.suggested_jira_issue_key.as_deref(),
    )
}

fn aggregate_session_chunk(
    sessions: &[ActivityWatchSessionCandidate],
) -> ActivityWatchSessionCandidate {
    debug_assert!(!sessions.is_empty());
    let representative = sessions
        .iter()
        .max_by_key(|session| session.duration_seconds)
        .expect("non-empty review chunk");
    let first = &sessions[0];
    let last = &sessions[sessions.len() - 1];
    ActivityWatchSessionCandidate {
        id: String::new(),
        kind: representative.kind,
        started_at_unix_ms: first.started_at_unix_ms,
        ended_at_unix_ms: last.ended_at_unix_ms,
        duration_seconds: sessions
            .iter()
            .map(|session| session.duration_seconds)
            .sum(),
        description: representative.description.clone(),
        application: representative.application.clone(),
        activity_evidence: representative.activity_evidence.clone(),
        jira_issue_key: first.jira_issue_key.clone(),
        suggested_jira_issue_key: first.suggested_jira_issue_key.clone(),
        jira_suggestion_confidence: sessions
            .iter()
            .filter_map(|session| session.jira_suggestion_confidence)
            .max(),
        jira_suggestion_reason: sessions
            .iter()
            .find_map(|session| session.jira_suggestion_reason.clone()),
        source_event_count: sessions
            .iter()
            .map(|session| session.source_event_count)
            .sum(),
    }
}

fn collapse_transient_interruptions(sessions: &mut Vec<ActivityWatchSessionCandidate>) {
    let mut index = 1usize;
    while index + 1 < sessions.len() {
        let middle = &sessions[index];
        let previous = &sessions[index - 1];
        let next = &sessions[index + 1];
        let middle_has_jira_evidence =
            middle.jira_issue_key.is_some() || middle.suggested_jira_issue_key.is_some();
        let same_surrounding_context = previous.kind == next.kind
            && previous.jira_issue_key == next.jira_issue_key
            && previous.suggested_jira_issue_key == next.suggested_jira_issue_key
            && previous.description == next.description;
        if middle.duration_seconds < TRANSIENT_SESSION_SECONDS
            && !middle_has_jira_evidence
            && previous.ended_at_unix_ms == middle.started_at_unix_ms
            && middle.ended_at_unix_ms == next.started_at_unix_ms
            && same_surrounding_context
        {
            let next = sessions.remove(index + 1);
            let middle = sessions.remove(index);
            let previous = &mut sessions[index - 1];
            previous.ended_at_unix_ms = next.ended_at_unix_ms;
            previous.duration_seconds =
                ((previous.ended_at_unix_ms - previous.started_at_unix_ms) / 1_000) as u64;
            previous.source_event_count = previous
                .source_event_count
                .saturating_add(middle.source_event_count)
                .saturating_add(next.source_event_count);
            index = index.saturating_sub(1).max(1);
        } else {
            index += 1;
        }
    }
}

fn unix_milliseconds_to_rfc3339(value: i64) -> Option<String> {
    if value < 0 {
        return None;
    }
    let seconds = value / 1_000;
    let milliseconds = value % 1_000;
    let days = seconds / 86_400;
    let seconds_in_day = seconds % 86_400;
    let (year, month, day) = civil_from_days(days);
    let hour = seconds_in_day / 3_600;
    let minute = (seconds_in_day % 3_600) / 60;
    let second = seconds_in_day % 60;
    Some(format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{milliseconds:03}Z"
    ))
}

fn parse_rfc3339_milliseconds(value: &str) -> Option<i64> {
    let bytes = value.as_bytes();
    if bytes.len() < 20
        || bytes.get(4) != Some(&b'-')
        || bytes.get(7) != Some(&b'-')
        || !matches!(bytes.get(10), Some(b'T' | b't' | b' '))
        || bytes.get(13) != Some(&b':')
        || bytes.get(16) != Some(&b':')
    {
        return None;
    }
    let year = parse_digits(bytes.get(0..4)?)? as i64;
    let month = parse_digits(bytes.get(5..7)?)? as i64;
    let day = parse_digits(bytes.get(8..10)?)? as i64;
    let hour = parse_digits(bytes.get(11..13)?)? as i64;
    let minute = parse_digits(bytes.get(14..16)?)? as i64;
    let second = parse_digits(bytes.get(17..19)?)? as i64;
    if !(1..=12).contains(&month)
        || !(1..=days_in_month(year, month)).contains(&day)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return None;
    }
    let mut cursor = 19usize;
    let mut milliseconds = 0i64;
    if bytes.get(cursor) == Some(&b'.') {
        cursor += 1;
        let fraction_start = cursor;
        while bytes.get(cursor).is_some_and(u8::is_ascii_digit) {
            cursor += 1;
        }
        if cursor == fraction_start {
            return None;
        }
        let fraction = &bytes[fraction_start..cursor];
        milliseconds = i64::from(fraction[0] - b'0') * 100;
        if fraction.len() > 1 {
            milliseconds += i64::from(fraction[1] - b'0') * 10;
        }
        if fraction.len() > 2 {
            milliseconds += i64::from(fraction[2] - b'0');
        }
    }
    let offset_seconds = match bytes.get(cursor) {
        Some(b'Z' | b'z') if cursor + 1 == bytes.len() => 0,
        Some(sign @ (b'+' | b'-'))
            if cursor + 6 == bytes.len() && bytes.get(cursor + 3) == Some(&b':') =>
        {
            let offset_hour = parse_digits(bytes.get(cursor + 1..cursor + 3)?)? as i64;
            let offset_minute = parse_digits(bytes.get(cursor + 4..cursor + 6)?)? as i64;
            if offset_hour > 23 || offset_minute > 59 {
                return None;
            }
            let offset = offset_hour * 3_600 + offset_minute * 60;
            if *sign == b'+' { offset } else { -offset }
        }
        _ => return None,
    };
    let seconds = days_from_civil(year, month, day)
        .checked_mul(86_400)?
        .checked_add(hour * 3_600 + minute * 60 + second)?
        .checked_sub(offset_seconds)?;
    seconds.checked_mul(1_000)?.checked_add(milliseconds)
}

fn parse_digits(bytes: &[u8]) -> Option<u32> {
    if bytes.is_empty() || !bytes.iter().all(u8::is_ascii_digit) {
        return None;
    }
    bytes.iter().try_fold(0u32, |value, byte| {
        value.checked_mul(10)?.checked_add(u32::from(*byte - b'0'))
    })
}

fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

// Civil date conversion algorithms by Howard Hinnant, adapted to i64.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let adjusted_year = year - i64::from(month <= 2);
    let era = adjusted_year.div_euclid(400);
    let year_of_era = adjusted_year - era * 400;
    let adjusted_month = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * adjusted_month + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    (year, month, day)
}

#[derive(Deserialize)]
struct ActivityWatchInfo {
    version: String,
}

fn validate_origin(endpoint: &str) -> Result<Url, ActivityWatchError> {
    let endpoint = endpoint.trim();
    let url = Url::parse(endpoint).map_err(|_| ActivityWatchError::InvalidEndpoint)?;
    if url.scheme() != "http"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.path(), "" | "/")
    {
        return Err(ActivityWatchError::InvalidEndpoint);
    }
    let address = url
        .host_str()
        .and_then(|host| host.parse::<IpAddr>().ok())
        .ok_or(ActivityWatchError::InvalidEndpoint)?;
    if !address.is_loopback() {
        return Err(ActivityWatchError::InvalidEndpoint);
    }
    Ok(url)
}

fn valid_version(version: &str) -> bool {
    !version.is_empty()
        && version.len() <= MAX_VERSION_BYTES
        && version
            .bytes()
            .all(|byte| byte.is_ascii_graphic() || byte == b' ')
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ReadFailure {
    TooLarge,
    Io,
}

fn read_bounded(response: Response, maximum_bytes: usize) -> Result<Vec<u8>, ReadFailure> {
    if response
        .content_length()
        .is_some_and(|length| length > maximum_bytes as u64)
    {
        return Err(ReadFailure::TooLarge);
    }
    let limit = u64::try_from(maximum_bytes.saturating_add(1)).unwrap_or(u64::MAX);
    let mut body = Vec::with_capacity(maximum_bytes.min(4096));
    response
        .take(limit)
        .read_to_end(&mut body)
        .map_err(|error| match error.kind() {
            io::ErrorKind::UnexpectedEof => ReadFailure::Io,
            _ => ReadFailure::Io,
        })?;
    if body.len() > maximum_bytes {
        return Err(ReadFailure::TooLarge);
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        thread,
    };

    fn mock_response(response: &'static [u8]) -> (String, thread::JoinHandle<Vec<u8>>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock ActivityWatch");
        let address = listener.local_addr().expect("mock address");
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept request");
            let mut request = vec![0; 4096];
            let size = stream.read(&mut request).expect("read request");
            stream.write_all(response).expect("write response");
            request.truncate(size);
            request
        });
        (format!("http://{address}"), handle)
    }

    fn mock_responses(responses: Vec<Vec<u8>>) -> (String, thread::JoinHandle<Vec<Vec<u8>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock ActivityWatch");
        let address = listener.local_addr().expect("mock address");
        let handle = thread::spawn(move || {
            responses
                .into_iter()
                .map(|response| {
                    let (mut stream, _) = listener.accept().expect("accept request");
                    let mut request = vec![0; 8192];
                    let size = stream.read(&mut request).expect("read request");
                    stream.write_all(&response).expect("write response");
                    request.truncate(size);
                    request
                })
                .collect()
        });
        (format!("http://{address}"), handle)
    }

    fn json_response(body: &str) -> Vec<u8> {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .into_bytes()
    }

    /// Answers each request after the delay, like a cold ActivityWatch database.
    fn slow_responses(responses: Vec<Vec<u8>>, delay: Duration) -> (String, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock ActivityWatch");
        let address = listener.local_addr().expect("mock address");
        let handle = thread::spawn(move || {
            for response in responses {
                let Ok((mut stream, _)) = listener.accept() else { return };
                let mut request = vec![0; 8192];
                let _ = stream.read(&mut request);
                thread::sleep(delay);
                let _ = stream.write_all(&response);
            }
        });
        (format!("http://{address}"), handle)
    }

    #[test]
    fn daily_review_allows_a_slow_bucket_read_beyond_the_status_timeout() {
        let (endpoint, server) = slow_responses(vec![json_response("{}")], Duration::from_millis(2_600));
        let review = ActivityWatchConnector::new(&endpoint)
            .unwrap()
            .daily_review(1_785_402_000_000, 1_785_403_200_000);
        server.join().unwrap();
        assert!(review.is_ok(), "a 2.6 second read must not fail the review: {review:?}");

        let (endpoint, _server) = slow_responses(vec![json_response("{}")], Duration::from_millis(1_500));
        let review = ActivityWatchConnector::new(&endpoint)
            .unwrap()
            .with_review_timeout(Duration::from_millis(300))
            .daily_review(1_785_402_000_000, 1_785_403_200_000);
        assert!(matches!(review, Err(ActivityWatchReviewError::RequestTimedOut)));
    }

    #[test]
    fn rejects_every_non_loopback_or_credentialed_endpoint_before_connecting() {
        for endpoint in [
            "https://127.0.0.1:5600",
            "http://activitywatch.example:5600",
            "http://192.168.1.4:5600",
            "http://user:secret@127.0.0.1:5600",
            "http://127.0.0.1:5600/api",
            "http://127.0.0.1:5600/?token=secret",
        ] {
            assert_eq!(
                ActivityWatchConnector::new(endpoint).unwrap_err(),
                ActivityWatchError::InvalidEndpoint,
                "{endpoint} must not cross the local connector boundary"
            );
        }
    }

    #[test]
    fn probes_only_api_info_and_returns_a_secret_free_serialized_contract() {
        let body = br#"{"hostname":"developer-private-mac","version":"v0.13.2"}"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            std::str::from_utf8(body).unwrap()
        );
        let leaked_response: &'static [u8] = Box::leak(response.into_bytes().into_boxed_slice());
        let (endpoint, request) = mock_response(leaked_response);
        let status = ActivityWatchConnector::new(&endpoint).unwrap().status();
        let request = String::from_utf8(request.join().unwrap()).unwrap();

        assert!(request.starts_with("GET /api/0/info HTTP/1.1\r\n"));
        let serialized = serde_json::to_value(status).unwrap();
        assert_eq!(serialized["state"], "running");
        assert_eq!(serialized["installation"], "detected");
        assert_eq!(serialized["apiVersion"], "v0");
        assert_eq!(serialized["serverVersion"], "v0.13.2");
        assert_eq!(
            serialized["capabilities"],
            serde_json::json!(["status", "dailyReview"])
        );
        assert_eq!(
            serialized
                .as_object()
                .unwrap()
                .keys()
                .cloned()
                .collect::<Vec<_>>(),
            vec![
                "apiVersion",
                "capabilities",
                "detail",
                "endpoint",
                "installation",
                "serverVersion",
                "state",
            ]
        );
        let serialized = serialized.to_string();
        assert!(!serialized.contains("developer-private-mac"));
        assert!(!serialized.contains("hostname"));
    }

    #[test]
    fn does_not_follow_redirects_outside_the_loopback_boundary() {
        let response = b"HTTP/1.1 302 Found\r\nLocation: https://activitywatch.example/api/0/info\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        let (endpoint, request) = mock_response(response);
        let status = ActivityWatchConnector::new(&endpoint).unwrap().status();
        request.join().unwrap();

        assert_eq!(status.state, ActivityWatchState::Incompatible);
        assert_eq!(
            status.diagnostic_code,
            Some(ActivityWatchDiagnosticCode::ServerRejected)
        );
    }

    #[test]
    fn caps_the_upstream_response_before_json_parsing() {
        let response = b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\n";
        let (endpoint, request) = mock_response(response);
        let connector = ActivityWatchConnector::with_limits(
            &endpoint,
            Duration::from_millis(100),
            Duration::from_millis(500),
            16,
        )
        .unwrap();
        let status = connector.status();
        request.join().unwrap();

        assert_eq!(status.state, ActivityWatchState::Incompatible);
        assert_eq!(
            status.diagnostic_code,
            Some(ActivityWatchDiagnosticCode::ResponseTooLarge)
        );
    }

    #[test]
    fn reports_unavailable_without_claiming_installation_when_nothing_is_listening() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("reserve loopback address");
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);

        let status = ActivityWatchConnector::with_limits(
            &endpoint,
            Duration::from_millis(100),
            Duration::from_millis(200),
            1024,
        )
        .unwrap()
        .status();

        assert_eq!(status.state, ActivityWatchState::Unavailable);
        assert_eq!(status.installation, ActivityWatchInstallation::Unknown);
        assert_eq!(status.capabilities, vec![]);
        assert_eq!(
            status.diagnostic_code,
            Some(ActivityWatchDiagnosticCode::ConnectionFailed)
        );
    }

    #[test]
    fn converts_activity_events_to_a_bounded_secret_free_daily_review() {
        let buckets = r#"{
          "aw-afk": {"id":"aw-afk","type":"afkstatus"},
          "aw-editor": {"id":"aw-editor","type":"app.editor.activity"}
        }"#;
        let afk = r#"[
          {"timestamp":"2026-07-30T09:10:00.000Z","duration":60,"data":{"status":"afk"}}
        ]"#;
        let editor = r#"[
          {
            "timestamp":"2026-07-30T09:00:00.000Z",
            "duration":1200,
            "data":{
              "app":"Visual Studio Code",
              "project":"/Users/example/acme",
              "title":"PLATFORM-42 auth.py private.person@example.com",
              "url":"https://internal.example/path?token=secret"
            }
          }
        ]"#;
        let (endpoint, requests) = mock_responses(vec![
            json_response(buckets),
            json_response(afk),
            json_response(editor),
        ]);
        let review = ActivityWatchConnector::new(&endpoint)
            .unwrap()
            .daily_review(1_785_402_000_000, 1_785_403_200_000)
            .unwrap();
        let requests = requests.join().unwrap();

        assert_eq!(requests.len(), 3);
        assert!(String::from_utf8_lossy(&requests[0]).starts_with("GET /api/0/buckets/ HTTP/1.1"));
        assert!(String::from_utf8_lossy(&requests[1]).contains("/api/0/buckets/aw-afk/events?"));
        assert!(String::from_utf8_lossy(&requests[2]).contains("/api/0/buckets/aw-editor/events?"));
        assert_eq!(review.sessions.len(), 1);
        assert_eq!(review.total_active_seconds, 1_140);
        assert!(review.sessions.iter().all(|session| {
            session.kind == ActivityWatchSessionKind::Coding
                && session.jira_issue_key.as_deref() == Some("PLATFORM-42")
                && session.description == "Coding work for PLATFORM-42"
        }));
        assert!(review.sessions.iter().all(|session| {
            session.application.as_deref() == Some("Visual Studio Code")
                && session.activity_evidence.as_deref() == Some("PLATFORM-42")
        }));

        let serialized = serde_json::to_string(&review).unwrap();
        for private_value in [
            "private.person",
            "token=secret",
            "/Users/private",
            "aw-editor",
        ] {
            assert!(
                !serialized.contains(private_value),
                "daily review must not retain {private_value}"
            );
        }
    }

    #[test]
    fn matches_ephemeral_activity_context_to_one_assignable_jira_summary() {
        let buckets = r#"{
          "aw-window": {"id":"aw-window","type":"currentwindow"}
        }"#;
        let window = r#"[
          {
            "timestamp":"2026-07-30T09:00:00.000Z",
            "duration":120,
            "data":{
              "app":"Unknown",
              "title":"Under eval flow check and optimisation — private workspace",
              "url":"https://internal.example/path?token=secret"
            }
          }
        ]"#;
        let (endpoint, requests) =
            mock_responses(vec![json_response(buckets), json_response(window)]);
        let issues = vec![
            JiraActiveIssue {
                issue_key: "PLATFORM-6264".to_owned(),
                summary: "Under eval flow check and optimisation".to_owned(),
                status: "In Progress".to_owned(),
            },
            JiraActiveIssue {
                issue_key: "OPS-41".to_owned(),
                summary: "Repair CI environment".to_owned(),
                status: "Open".to_owned(),
            },
        ];

        let review = ActivityWatchConnector::new(&endpoint)
            .unwrap()
            .daily_review_with_jira_issues(1_785_402_000_000, 1_785_403_200_000, &issues)
            .unwrap();
        requests.join().unwrap();

        assert_eq!(review.sessions.len(), 1);
        let session = &review.sessions[0];
        assert_eq!(
            session.suggested_jira_issue_key.as_deref(),
            Some("PLATFORM-6264")
        );
        assert!(
            session
                .jira_suggestion_confidence
                .is_some_and(|value| value >= 70)
        );
        assert_eq!(
            session.jira_suggestion_reason.as_deref(),
            Some("Activity context matches 5 distinctive words in the Jira summary")
        );

        let serialized = serde_json::to_string(&review).unwrap();
        assert!(serialized.contains("Under eval flow check and optimisation"));
        for private_value in ["token=secret", "https://internal.example/path"] {
            assert!(
                !serialized.contains(private_value),
                "semantic matching must discard {private_value}"
            );
        }
    }

    #[test]
    fn classifies_browser_windows_and_collapses_only_unsupported_interruptions() {
        let browser = DerivedActivity::from_event(
            ActivitySource::Window,
            0,
            60_000,
            &HashMap::from([
                (
                    "app".to_owned(),
                    serde_json::Value::String("Google Chrome".to_owned()),
                ),
                (
                    "title".to_owned(),
                    serde_json::Value::String("Private tab title".to_owned()),
                ),
            ]),
            &[],
        );
        assert_eq!(browser.kind, ActivityWatchSessionKind::Browser);

        let session =
            |kind, start, end, jira_issue_key: Option<&str>| ActivityWatchSessionCandidate {
                id: String::new(),
                kind,
                started_at_unix_ms: start,
                ended_at_unix_ms: end,
                duration_seconds: ((end - start) / 1_000) as u64,
                description: match kind {
                    ActivityWatchSessionKind::Browser => "Browser research".to_owned(),
                    _ => "Other active work".to_owned(),
                },
                application: None,
                activity_evidence: None,
                jira_issue_key: jira_issue_key.map(ToOwned::to_owned),
                suggested_jira_issue_key: None,
                jira_suggestion_confidence: None,
                jira_suggestion_reason: None,
                source_event_count: 1,
            };
        let mut sessions = vec![
            session(ActivityWatchSessionKind::Browser, 0, 60_000, None),
            session(ActivityWatchSessionKind::Other, 60_000, 65_000, None),
            session(ActivityWatchSessionKind::Browser, 65_000, 125_000, None),
        ];
        collapse_transient_interruptions(&mut sessions);
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].duration_seconds, 125);

        let mut jira_evidence = vec![
            session(ActivityWatchSessionKind::Browser, 0, 60_000, None),
            session(
                ActivityWatchSessionKind::Other,
                60_000,
                65_000,
                Some("OPS-41"),
            ),
            session(ActivityWatchSessionKind::Browser, 65_000, 125_000, None),
        ];
        collapse_transient_interruptions(&mut jira_evidence);
        assert_eq!(jira_evidence.len(), 3);
    }

    #[test]
    fn sanitizes_recognizable_activity_evidence_at_the_serialized_boundary() {
        let activity = DerivedActivity::from_event(
            ActivitySource::Window,
            0,
            60_000,
            &HashMap::from([
                (
                    "app".to_owned(),
                    serde_json::Value::String("Bruno".to_owned()),
                ),
                (
                    "title".to_owned(),
                    serde_json::Value::String(
                        "Implement provisioning flow auth.py private.person@example.com \
                         https://internal.example/path?token=secret token=another-secret"
                            .to_owned(),
                    ),
                ),
                (
                    "project".to_owned(),
                    serde_json::Value::String("/Users/example/company/repository".to_owned()),
                ),
            ]),
            &[],
        );
        let sessions = sessionize(vec![activity], vec![], 0, 60_000);
        let serialized = serde_json::to_value(&sessions[0]).unwrap();

        assert_eq!(serialized["application"], "Bruno");
        assert_eq!(
            serialized["activityEvidence"],
            "Implement provisioning flow"
        );
        for private_value in [
            "auth.py",
            "private.person",
            "internal.example",
            "token=",
            "another-secret",
            "/Users/private",
            "repository",
        ] {
            assert!(
                !serialized.to_string().contains(private_value),
                "serialized evidence must not retain {private_value}"
            );
        }
    }

    #[test]
    fn aggregates_micro_activity_into_review_blocks_and_preserves_jira_boundaries() {
        let session = |index: i64, jira_issue_key: Option<&str>| ActivityWatchSessionCandidate {
            id: String::new(),
            kind: if index % 2 == 0 {
                ActivityWatchSessionKind::Browser
            } else {
                ActivityWatchSessionKind::Coding
            },
            started_at_unix_ms: index * 60_000,
            ended_at_unix_ms: (index + 1) * 60_000,
            duration_seconds: 60,
            description: "Reviewable work".to_owned(),
            application: Some(if index % 2 == 0 {
                "Google Chrome".to_owned()
            } else {
                "Visual Studio Code".to_owned()
            }),
            activity_evidence: Some("Provisioning flow".to_owned()),
            jira_issue_key: jira_issue_key.map(ToOwned::to_owned),
            suggested_jira_issue_key: None,
            jira_suggestion_confidence: None,
            jira_suggestion_reason: None,
            source_event_count: 1,
        };

        let micro_sessions = (0..60).map(|index| session(index, None)).collect();
        let aggregated = aggregate_review_sessions(micro_sessions);
        assert_eq!(aggregated.len(), 2);
        assert_eq!(
            aggregated
                .iter()
                .map(|session| session.duration_seconds)
                .sum::<u64>(),
            3_600
        );
        assert_eq!(
            aggregated
                .iter()
                .map(|session| session.source_event_count)
                .sum::<usize>(),
            60
        );

        let jira_partitioned = aggregate_review_sessions(vec![
            session(0, None),
            session(1, Some("OPS-41")),
            session(2, Some("OPS-41")),
            session(3, None),
        ]);
        assert_eq!(jira_partitioned.len(), 3);
        assert_eq!(
            jira_partitioned[1].jira_issue_key.as_deref(),
            Some("OPS-41")
        );
        assert_eq!(jira_partitioned[1].source_event_count, 2);
    }

    #[test]
    fn rejects_review_windows_over_48_hours_before_reading_activity() {
        let connector = ActivityWatchConnector::new("http://127.0.0.1:5600").unwrap();
        assert_eq!(
            connector.daily_review(1_000, 172_801_001).unwrap_err(),
            ActivityWatchReviewError::InvalidTimeRange
        );
    }

    #[test]
    fn reports_a_canonical_endpoint_error_without_following_activity_redirects() {
        let response = b"HTTP/1.1 308 Permanent Redirect\r\nLocation: http://127.0.0.1:9/api/0/buckets/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        let (endpoint, request) = mock_response(response);
        let error = ActivityWatchConnector::new(&endpoint)
            .unwrap()
            .daily_review(1_785_402_000_000, 1_785_403_200_000)
            .unwrap_err();
        request.join().unwrap();

        assert_eq!(error, ActivityWatchReviewError::EndpointRedirected);
        assert_eq!(
            error.safe_message(),
            "ActivityWatch redirected a local API request. Use the canonical loopback endpoint."
        );
    }

    #[test]
    fn parses_and_formats_activity_watch_rfc3339_timestamps() {
        assert_eq!(
            unix_milliseconds_to_rfc3339(0).as_deref(),
            Some("1970-01-01T00:00:00.000Z")
        );
        assert_eq!(
            parse_rfc3339_milliseconds("1970-01-01T05:30:00.125+05:30"),
            Some(125)
        );
        assert_eq!(
            parse_rfc3339_milliseconds("2024-02-29T23:59:59Z"),
            Some(1_709_251_199_000)
        );
    }
}
