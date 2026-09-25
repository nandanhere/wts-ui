use crate::{AgentProvider, LocalWtsError, ReviewCodeSide};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

pub const CODE_REVIEW_SCHEMA_VERSION: u32 = 2;
/// The Raptik size gate. Pratik stops reading above this many changed lines.
pub const RAPTIK_SIZE_GATE_LINES: u32 = 500;
const MAX_FINDINGS: usize = 200;
const MAX_TITLE_CHARS: usize = 240;
const MAX_TEXT_CHARS: usize = 4_000;
const MAX_CODE_CHARS: usize = 2_000;
const MAX_SUMMARY_CHARS: usize = 4_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CodeReviewScope {
    RecentChanges,
    TotalCode,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CodeReviewFindingSeverity {
    Critical,
    Warning,
    Suggestion,
}

/// Raptik labels, in report order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CodeReviewLabel {
    Blocking,
    Issue,
    Question,
    Suggestion,
    Nit,
    Praise,
}

impl CodeReviewLabel {
    fn parse(value: &str) -> Option<Self> {
        match value.trim().trim_start_matches('/').to_ascii_lowercase().as_str() {
            "blocking" | "blocker" | "critical" => Some(Self::Blocking),
            "issue" | "warning" | "major" => Some(Self::Issue),
            "question" => Some(Self::Question),
            "suggestion" | "minor" => Some(Self::Suggestion),
            "nit" | "nitpick" | "style" => Some(Self::Nit),
            "praise" => Some(Self::Praise),
            _ => None,
        }
    }

    fn severity(self) -> CodeReviewFindingSeverity {
        match self {
            Self::Blocking => CodeReviewFindingSeverity::Critical,
            Self::Issue => CodeReviewFindingSeverity::Warning,
            _ => CodeReviewFindingSeverity::Suggestion,
        }
    }

    fn prefix(self) -> &'static str {
        match self {
            Self::Blocking => "Blocking",
            Self::Issue => "Issue",
            Self::Question => "Question",
            Self::Suggestion => "Suggestion",
            Self::Nit => "Nit",
            Self::Praise => "/praise",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeReviewPrecedent {
    pub body: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    pub score: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeReviewFinding {
    pub finding_id: String,
    pub severity: CodeReviewFindingSeverity,
    #[serde(default = "default_label")]
    pub label: CodeReviewLabel,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository_id: Option<String>,
    pub file_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub side: Option<ReviewCodeSide>,
    /// True when the file, line, and side name a changed line in the reviewed patch.
    #[serde(default)]
    pub anchored: bool,
    pub title: String,
    pub explanation: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suggested_comment: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suggested_patch: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub also_lines: Vec<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub precedent: Option<CodeReviewPrecedent>,
}

fn default_label() -> CodeReviewLabel {
    CodeReviewLabel::Suggestion
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeReviewActionableStep {
    pub step_number: u32,
    pub instruction: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CodeReviewMode {
    Raptik,
    /// A review skill other than Raptik ran the review.
    Skill,
    Standard,
}

/// The review skill that shaped a review.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeReviewSkillRef {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reviewer: Option<String>,
}

/// The GitLab merge request version that a repository review covered.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeReviewMergeRequest {
    pub iid: u64,
    pub base_commit_oid: String,
    pub start_commit_oid: String,
    pub head_commit_oid: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CodeReviewStrictness {
    Strict,
    Normal,
}

/// The exact patch that one repository review covered.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeReviewRepository {
    pub repository_id: String,
    pub repository_label: String,
    pub base_commit_oid: String,
    pub head_commit_oid: String,
    pub patch_sha256: String,
    pub changed_lines: u32,
    pub size_gate_exceeded: bool,
    pub strictness: CodeReviewStrictness,
    #[serde(default)]
    pub patch_truncated: bool,
    /// Set when WTS reviewed the published merge request patch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merge_request: Option<CodeReviewMergeRequest>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CodeReviewOutcome {
    /// The agent reviewed the changes.
    Reviewed,
    /// The size gate stopped the review before the agent ran.
    SizeGateStopped,
    /// The agent answered, but WTS could not read structured findings.
    Unstructured,
    /// No repository had changes to review.
    NoChanges,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceCodeReviewResult {
    #[serde(default)]
    pub schema_version: u32,
    pub workspace_id: Uuid,
    pub provider: AgentProvider,
    pub scope: CodeReviewScope,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(default = "default_mode")]
    pub mode: CodeReviewMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skill: Option<CodeReviewSkillRef>,
    #[serde(default = "default_outcome")]
    pub outcome: CodeReviewOutcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intent: Option<String>,
    pub summary: String,
    pub findings: Vec<CodeReviewFinding>,
    pub actionable_steps: Vec<CodeReviewActionableStep>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub suggested_tests: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub not_checked: Vec<String>,
    #[serde(default)]
    pub repositories: Vec<CodeReviewRepository>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_output: Option<String>,
    pub reviewed_at_unix_ms: i64,
}

fn default_mode() -> CodeReviewMode {
    CodeReviewMode::Standard
}

fn default_outcome() -> CodeReviewOutcome {
    CodeReviewOutcome::Reviewed
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunWorkspaceCodeReviewRequest {
    pub provider: AgentProvider,
    pub scope: CodeReviewScope,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    /// Limits the review to one repository in the workspace.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository_id: Option<String>,
    /// Runs the review when the change is over the skill size gate.
    #[serde(default)]
    pub ignore_size_gate: bool,
    /// The review skill ID. "none" runs without a skill. No value picks the default skill.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skill: Option<String>,
    /// Reviews the published patch of this GitLab merge request. Needs repositoryId.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merge_request_iid: Option<u64>,
}

/// The review options after the transport layer.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CodeReviewOptions {
    pub model: Option<String>,
    pub repository_id: Option<String>,
    pub ignore_size_gate: bool,
    pub skill: Option<String>,
    pub merge_request_iid: Option<u64>,
}

impl RunWorkspaceCodeReviewRequest {
    pub fn options(&self) -> CodeReviewOptions {
        CodeReviewOptions {
            model: self.model.clone().or_else(|| self.agent.clone()),
            repository_id: self.repository_id.clone(),
            ignore_size_gate: self.ignore_size_gate,
            skill: self.skill.clone(),
            merge_request_iid: self.merge_request_iid,
        }
    }
}

/// Counts reviewable changed lines. Lock files, vendored code, and generated files do not count.
pub fn count_reviewable_changed_lines(patch: &str) -> u32 {
    let mut count = 0_u32;
    let mut counted_file = true;
    for line in patch.lines() {
        if let Some(rest) = line.strip_prefix("diff --git ") {
            let path = rest.rsplit(" b/").next().unwrap_or(rest);
            counted_file = !is_excluded_from_size_gate(path);
            continue;
        }
        if line.starts_with("+++ ") || line.starts_with("--- ") {
            continue;
        }
        if counted_file && (line.starts_with('+') || line.starts_with('-')) {
            count = count.saturating_add(1);
        }
    }
    count
}

fn is_excluded_from_size_gate(path: &str) -> bool {
    let path = path.trim_matches('"');
    let leaf = path.rsplit('/').next().unwrap_or(path);
    leaf.ends_with(".lock")
        || matches!(
            leaf,
            "package-lock.json" | "pnpm-lock.yaml" | "yarn.lock" | "go.sum" | "Cargo.lock" | "poetry.lock"
        )
        || leaf.contains(".generated.")
        || leaf.ends_with(".pb.go")
        || leaf.ends_with(".min.js")
        || path.starts_with("vendor/")
        || path.contains("/vendor/")
        || path.starts_with("node_modules/")
}

const STRICT_REPOSITORIES: [&str; 3] = ["senzu", "pious", "coredhcp"];

/// Picks the Raptik strictness from the repository name and the changed files.
pub fn raptik_strictness(repository_label: &str, patch: &str) -> CodeReviewStrictness {
    let strict = STRICT_REPOSITORIES.map(str::to_owned);
    review_strictness(repository_label, patch, &strict)
}

/// Strict for listed repositories and for backend files. Names compare without "-" and "_".
pub(crate) fn review_strictness(repository_label: &str, patch: &str, strict_repositories: &[String]) -> CodeReviewStrictness {
    let label = repository_label.to_ascii_lowercase().replace(['-', '_'], "");
    if strict_repositories.iter().any(|name| !name.is_empty() && label.contains(name.as_str())) {
        return CodeReviewStrictness::Strict;
    }
    let backend = patch.lines().filter_map(|line| line.strip_prefix("+++ b/")).any(|path| {
        [".go", ".py", ".rs", ".java", ".kt", ".sql"]
            .iter()
            .any(|extension| path.ends_with(extension))
    });
    if backend {
        CodeReviewStrictness::Strict
    } else {
        CodeReviewStrictness::Normal
    }
}

pub(crate) struct SkillPromptInput<'a> {
    pub(crate) skill_id: &'a str,
    pub(crate) reviewer: Option<&'a str>,
    pub(crate) rules: &'a str,
    pub(crate) references: &'a [(String, String)],
    pub(crate) precedents_available: bool,
    pub(crate) size_gate_lines: Option<u32>,
    pub(crate) intent: &'a str,
    pub(crate) repositories: &'a [(CodeReviewRepository, String)],
    pub(crate) scope: CodeReviewScope,
    pub(crate) patch_budget: usize,
}

/// The output contract of every WTS review. docs/review-skills.md describes each field.
pub(crate) const REVIEW_OUTPUT_CONTRACT: &str = r#"Respond with one JSON object and no other text. Use this shape:
{
  "intent": "2 to 3 lines about what the change is meant to do",
  "scope": "matches ticket | mismatch: <reason>",
  "summary": "one short paragraph. Say plainly if there are no Blocking items.",
  "findings": [
    {
      "label": "blocking | issue | question | suggestion | nit | praise",
      "repository": "<repository label from the patch header>",
      "filePath": "<path inside the repository, as in the patch>",
      "line": 42,
      "side": "additions | deletions",
      "alsoLines": [55, 90],
      "title": "short title",
      "why": "<trigger> -> <what fails: panic, hang, corrupt data, silent error>",
      "code": "<the offending line>",
      "suggestedComment": "<ready-to-post MR comment with the label prefix>",
      "fix": "<optional minimal fix snippet>"
    }
  ],
  "suggestedTests": ["optional edge-case test"],
  "notChecked": ["anything you skipped, for example the Jira ticket"]
}
Rules for the JSON:
- Use a line number of a changed line in the patch. Use side "deletions" only for removed lines.
- One finding per line or pattern. Put repeats in alsoLines.
- Use label "question" when you cannot confirm a suspicion from the code. Write the question for the reviewer, then put the question to the author in suggestedComment. The reviewer answers it or posts it to the MR.
- Order findings by label: blocking, issue, question, suggestion, nit, praise.
- Do not give a merge verdict. Do not post to GitLab. Do not edit files."#;

pub(crate) fn build_skill_review_prompt(input: &SkillPromptInput<'_>) -> String {
    let mut prompt = String::new();
    prompt.push_str(&format!(
        "You run the {} review skill inside WTS. Follow the skill rules below. WTS shows your findings inline in its diff viewer, and the reviewer can post each suggested comment to the merge request.\n",
        input.skill_id
    ));
    prompt.push_str("WTS runs you in a read-only sandbox. Ignore any skill step that posts comments, edits files, or runs the skill scripts. WTS gives you the output shape at the end of this prompt. Use it in place of the report format in the skill.\n");
    if let Some(lines) = input.size_gate_lines {
        prompt.push_str(&format!("WTS already ran the size gate ({lines} lines) and picked the strictness for each repository.\n"));
    }
    if input.precedents_available {
        let reviewer = input.reviewer.unwrap_or("the reviewer");
        prompt.push_str(&format!(
            "WTS finds the closest past comments from {reviewer} for each finding. Do not search for them yourself.\n"
        ));
    }
    prompt.push('\n');
    prompt.push_str("<skill>\n");
    prompt.push_str(input.rules.trim());
    prompt.push_str("\n</skill>\n\n");
    for (name, text) in input.references {
        if text.trim().is_empty() {
            continue;
        }
        prompt.push_str(&format!("<reference file=\"{name}\">\n"));
        prompt.push_str(text.trim());
        prompt.push_str("\n</reference>\n\n");
    }
    prompt.push_str("<task>\n");
    prompt.push_str(input.intent.trim());
    prompt.push_str("\n</task>\n\n");
    push_patches(&mut prompt, input.repositories, input.scope, input.patch_budget);
    prompt.push_str(REVIEW_OUTPUT_CONTRACT);
    prompt
}

fn push_patches(prompt: &mut String, repositories: &[(CodeReviewRepository, String)], scope: CodeReviewScope, patch_budget: usize) {
    if scope == CodeReviewScope::TotalCode {
        prompt.push_str("Scope: review the complete repositories. Read files in the working directory. Use the patches below to find recent work first.\n\n");
    } else {
        prompt.push_str("Scope: review only the changed lines below. You may read the working directory for callers and context.\n\n");
    }
    let mut remaining = patch_budget;
    for (repository, patch) in repositories {
        let source = repository
            .merge_request
            .as_ref()
            .map(|merge_request| format!(" mergeRequest=\"!{}\" head=\"{}\"", merge_request.iid, short_oid(&merge_request.head_commit_oid)))
            .unwrap_or_default();
        prompt.push_str(&format!(
            "<repository label=\"{}\" base=\"{}\" mode=\"{}\" changedLines=\"{}\"{source}>\n",
            repository.repository_label,
            short_oid(&repository.base_commit_oid),
            match repository.strictness {
                CodeReviewStrictness::Strict => "strict",
                CodeReviewStrictness::Normal => "normal",
            },
            repository.changed_lines,
        ));
        if patch.is_empty() {
            prompt.push_str("No changes.\n");
        } else if remaining == 0 {
            prompt.push_str("[WTS omitted this patch to fit the prompt limit. Read the files in the working directory.]\n");
        } else {
            let slice = bounded_str(patch, remaining);
            prompt.push_str(slice);
            if slice.len() < patch.len() {
                prompt.push_str(&format!(
                    "\n[WTS truncated this patch at {} of {} bytes. List the rest under notChecked.]\n",
                    slice.len(),
                    patch.len()
                ));
            }
            remaining = remaining.saturating_sub(slice.len());
        }
        prompt.push_str("</repository>\n\n");
    }
}

/// Builds a prompt for code review matching the desired scope and optional model.
pub fn build_code_review_prompt(
    scope: CodeReviewScope,
    context_summary: &str,
    model: Option<&str>,
) -> String {
    let scope_instructions = match scope {
        CodeReviewScope::RecentChanges => {
            "Focus specifically on recent modifications, uncommitted changes, and new commits against the base branch. Examine correctness, edge cases, test coverage, and regressions introduced by these changes."
        }
        CodeReviewScope::TotalCode => {
            "Review the codebase architecture, integration patterns, structural risks, security boundaries, and overall health across all files."
        }
    };
    let model_note = if let Some(m) = model.filter(|s| !s.trim().is_empty()) {
        format!("\nConfigured model: {m}\n")
    } else {
        String::new()
    };
    format!(
        "You are an expert AI code reviewer.\n\
         Scope: {scope_instructions}\n\
         {model_note}\
         Workspace context:\n{context_summary}\n\n\
         {REVIEW_OUTPUT_CONTRACT}"
    )
}

fn short_oid(oid: &str) -> &str {
    oid.get(..12).unwrap_or(oid)
}

fn bounded_str(text: &str, maximum: usize) -> &str {
    if text.len() <= maximum {
        return text;
    }
    let mut boundary = maximum;
    while !text.is_char_boundary(boundary) {
        boundary -= 1;
    }
    &text[..boundary]
}

fn bounded_string(text: &str, maximum: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= maximum {
        return trimmed.to_owned();
    }
    let mut value = trimmed.chars().take(maximum).collect::<String>();
    value.push('…');
    value
}

/// Returns the final agent message. Codex and OpenCode print JSON event lines.
pub fn extract_agent_text(provider: AgentProvider, raw: &str) -> String {
    match provider {
        AgentProvider::Codex => {
            let message = raw
                .lines()
                .filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
                .filter(|event| {
                    event["type"] == "item.completed" && event["item"]["type"] == "agent_message"
                })
                .filter_map(|event| event["item"]["text"].as_str().map(str::to_owned))
                .next_back();
            message.unwrap_or_else(|| raw.to_owned())
        }
        AgentProvider::OpenCode => {
            let mut text = String::new();
            let mut found = false;
            for event in raw
                .lines()
                .filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
            {
                if event["type"] == "text"
                    && let Some(part) = event["part"]["text"].as_str()
                {
                    found = true;
                    text.push_str(part);
                }
            }
            if found { text } else { raw.to_owned() }
        }
        AgentProvider::Hermes | AgentProvider::Copilot => raw.to_owned(),
    }
}

/// Finds the review object in agent text: a fenced block, or the outermost braces.
fn review_json(text: &str) -> Option<Value> {
    let mut candidates = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find("```") {
        let after = &rest[start + 3..];
        let body_start = after.find('\n').map_or(0, |index| index + 1);
        let body = &after[body_start..];
        let Some(end) = body.find("```") else {
            break;
        };
        candidates.push(&body[..end]);
        rest = &body[end + 3..];
    }
    if let (Some(start), Some(end)) = (text.find('{'), text.rfind('}'))
        && start < end
    {
        candidates.push(&text[start..=end]);
    }
    candidates
        .into_iter()
        .filter_map(|candidate| serde_json::from_str::<Value>(candidate.trim()).ok())
        .find(|value| value.is_object() && (value.get("findings").is_some() || value.get("summary").is_some()))
}

fn text_field(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

fn line_field(value: &Value) -> Option<u32> {
    let line = value.get("line").or_else(|| value.get("lineNumber"))?;
    line.as_u64()
        .or_else(|| line.as_str().and_then(|text| text.trim().parse().ok()))
        .and_then(|line| u32::try_from(line).ok())
        .filter(|line| *line > 0)
}

/// A finding from the model, before WTS checks it against the patch.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ParsedFinding {
    pub(crate) label: CodeReviewLabel,
    pub(crate) repository: Option<String>,
    pub(crate) file_path: String,
    pub(crate) line: Option<u32>,
    pub(crate) side: Option<ReviewCodeSide>,
    pub(crate) also_lines: Vec<u32>,
    pub(crate) title: String,
    pub(crate) why: String,
    pub(crate) code: Option<String>,
    pub(crate) suggested_comment: Option<String>,
    pub(crate) fix: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct ParsedReview {
    pub(crate) structured: bool,
    pub(crate) intent: Option<String>,
    pub(crate) summary: String,
    pub(crate) findings: Vec<ParsedFinding>,
    pub(crate) steps: Vec<CodeReviewActionableStep>,
    pub(crate) suggested_tests: Vec<String>,
    pub(crate) not_checked: Vec<String>,
}

fn string_list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            item.as_str()
                .map(str::to_owned)
                .or_else(|| text_field(item, &["instruction", "text", "description"]))
        })
        .map(|text| bounded_string(&text, MAX_TEXT_CHARS))
        .filter(|text| !text.is_empty())
        .take(64)
        .collect()
}

fn split_file_line(path: &str) -> (String, Option<u32>) {
    if let Some((file, line)) = path.rsplit_once(':')
        && let Ok(line) = line.trim().parse::<u32>()
    {
        return (file.to_owned(), Some(line));
    }
    (path.to_owned(), None)
}

/// Parses agent text tolerantly. Unknown keys and label variants are accepted.
pub(crate) fn parse_review_text(text: &str) -> ParsedReview {
    let Some(value) = review_json(text) else {
        let summary = text.trim();
        return ParsedReview {
            structured: false,
            summary: if summary.is_empty() {
                "The agent returned no review text.".to_owned()
            } else {
                bounded_string(summary, MAX_SUMMARY_CHARS)
            },
            ..ParsedReview::default()
        };
    };
    let findings = value
        .get("findings")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|finding| {
            let label = text_field(finding, &["label", "severity", "type"])
                .and_then(|label| CodeReviewLabel::parse(&label))
                .unwrap_or(CodeReviewLabel::Suggestion);
            let raw_path = text_field(finding, &["filePath", "file", "path"])?;
            let (file_path, embedded_line) = split_file_line(&raw_path);
            let side = match text_field(finding, &["side"]).as_deref() {
                Some("deletions" | "deleted" | "old" | "left") => Some(ReviewCodeSide::Deletions),
                Some(_) => Some(ReviewCodeSide::Additions),
                None => None,
            };
            let why = text_field(finding, &["why", "explanation", "description", "detail"])
                .unwrap_or_default();
            let title = text_field(finding, &["title", "summary"])
                .unwrap_or_else(|| why.lines().next().unwrap_or("Review finding").to_owned());
            Some(ParsedFinding {
                label,
                repository: text_field(finding, &["repository", "repositoryLabel", "repo"]),
                file_path: bounded_string(file_path.trim_start_matches("./"), 1_024),
                line: line_field(finding).or(embedded_line),
                side,
                also_lines: finding
                    .get("alsoLines")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_u64)
                    .filter_map(|line| u32::try_from(line).ok())
                    .take(64)
                    .collect(),
                title: bounded_string(&title, MAX_TITLE_CHARS),
                why: bounded_string(&why, MAX_TEXT_CHARS),
                code: text_field(finding, &["code", "offendingCode"])
                    .map(|code| bounded_string(&code, MAX_CODE_CHARS)),
                suggested_comment: text_field(finding, &["suggestedComment", "comment"])
                    .map(|comment| bounded_string(&comment, MAX_TEXT_CHARS)),
                fix: text_field(finding, &["fix", "suggestedPatch", "suggestedFix"])
                    .map(|fix| bounded_string(&fix, MAX_CODE_CHARS)),
            })
        })
        .take(MAX_FINDINGS)
        .collect::<Vec<_>>();
    let steps = value
        .get("actionableSteps")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
        .filter_map(|(index, step)| {
            let instruction = step
                .as_str()
                .map(str::to_owned)
                .or_else(|| text_field(step, &["instruction", "text"]))?;
            Some(CodeReviewActionableStep {
                step_number: step
                    .get("stepNumber")
                    .and_then(Value::as_u64)
                    .and_then(|number| u32::try_from(number).ok())
                    .unwrap_or(index as u32 + 1),
                instruction: bounded_string(&instruction, MAX_TEXT_CHARS),
            })
        })
        .take(64)
        .collect();
    let summary = text_field(&value, &["summary"]).unwrap_or_else(|| {
        if findings.is_empty() {
            "The review found no issues.".to_owned()
        } else {
            format!("The review found {} items.", findings.len())
        }
    });
    let mut not_checked = string_list(value.get("notChecked"));
    if let Some(scope) = text_field(&value, &["scope"])
        && scope.to_ascii_lowercase().starts_with("mismatch")
    {
        not_checked.insert(0, bounded_string(&format!("Scope {scope}"), MAX_TEXT_CHARS));
    }
    ParsedReview {
        structured: true,
        intent: text_field(&value, &["intent"]).map(|intent| bounded_string(&intent, MAX_TEXT_CHARS)),
        summary: bounded_string(&summary, MAX_SUMMARY_CHARS),
        findings,
        steps,
        suggested_tests: string_list(value.get("suggestedTests")),
        not_checked,
    }
}

impl ParsedFinding {
    pub(crate) fn into_finding(
        self,
        index: usize,
        repository_id: Option<String>,
        anchor: Option<(u32, ReviewCodeSide)>,
        precedent: Option<CodeReviewPrecedent>,
    ) -> CodeReviewFinding {
        let suggested_comment = self.suggested_comment.map(|comment| {
            let prefix = self.label.prefix();
            if comment.to_ascii_lowercase().starts_with(&prefix.to_ascii_lowercase()) {
                comment
            } else {
                format!("{prefix}: {comment}")
            }
        });
        CodeReviewFinding {
            finding_id: format!("finding-{}", index + 1),
            severity: self.label.severity(),
            label: self.label,
            repository_id,
            file_path: self.file_path,
            line: anchor.map(|(line, _)| line).or(self.line),
            side: anchor.map(|(_, side)| side).or(self.side),
            anchored: anchor.is_some(),
            title: self.title,
            explanation: self.why,
            code: self.code,
            suggested_comment,
            suggested_patch: self.fix,
            also_lines: self.also_lines,
            precedent,
        }
    }
}

/// Parses or structures an agent code review response into a `WorkspaceCodeReviewResult`.
pub fn parse_code_review_outcome(
    workspace_id: Uuid,
    provider: AgentProvider,
    scope: CodeReviewScope,
    model: Option<String>,
    raw_output: &str,
    timestamp_ms: i64,
) -> Result<WorkspaceCodeReviewResult, LocalWtsError> {
    let text = extract_agent_text(provider, raw_output);
    let parsed = parse_review_text(&text);
    let structured = parsed.structured;
    Ok(WorkspaceCodeReviewResult {
        schema_version: CODE_REVIEW_SCHEMA_VERSION,
        workspace_id,
        provider,
        scope,
        model: model.clone(),
        agent: model,
        mode: CodeReviewMode::Standard,
        skill: None,
        outcome: if structured {
            CodeReviewOutcome::Reviewed
        } else {
            CodeReviewOutcome::Unstructured
        },
        intent: parsed.intent,
        summary: parsed.summary,
        findings: parsed
            .findings
            .into_iter()
            .enumerate()
            .map(|(index, finding)| finding.into_finding(index, None, None, None))
            .collect(),
        actionable_steps: parsed.steps,
        suggested_tests: parsed.suggested_tests,
        not_checked: parsed.not_checked,
        repositories: Vec::new(),
        raw_output: (!structured).then(|| bounded_string(&text, MAX_SUMMARY_CHARS)),
        reviewed_at_unix_ms: timestamp_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_structured_json_review_with_unknown_fields_and_legacy_severity() {
        let raw = r#"Here is the review.
```json
{
  "summary": "Detected 1 potential null dereference.",
  "confidence": "high",
  "findings": [
    {
      "findingId": "find-1",
      "severity": "warning",
      "filePath": "src/lib.rs",
      "line": "42",
      "title": "Unchecked Option unwrap",
      "explanation": "Calling unwrap() may panic if value is None.",
      "suggestedPatch": "if let Some(val) = opt { ... }",
      "category": "safety"
    }
  ],
  "actionableSteps": [{ "stepNumber": 1, "instruction": "Replace unwrap." }]
}
```"#;
        let result = parse_code_review_outcome(
            Uuid::new_v4(),
            AgentProvider::Copilot,
            CodeReviewScope::RecentChanges,
            Some("gpt-5.5".to_string()),
            raw,
            123,
        )
        .unwrap();
        assert_eq!(result.outcome, CodeReviewOutcome::Reviewed);
        assert_eq!(result.summary, "Detected 1 potential null dereference.");
        assert_eq!(result.findings.len(), 1);
        assert_eq!(result.findings[0].label, CodeReviewLabel::Issue);
        assert_eq!(result.findings[0].severity, CodeReviewFindingSeverity::Warning);
        assert_eq!(result.findings[0].line, Some(42));
        assert_eq!(result.findings[0].suggested_patch.as_deref(), Some("if let Some(val) = opt { ... }"));
        assert_eq!(result.actionable_steps.len(), 1);
    }

    #[test]
    fn reads_the_final_codex_agent_message_from_the_json_event_stream() {
        let review = serde_json::json!({
            "summary": "No Blocking items.",
            "findings": [{"label": "nit", "filePath": "a.go:7", "why": "naming", "suggestedComment": "rename `h` to handler?"}]
        })
        .to_string();
        let raw = format!(
            "{}\n{}\n{}\n",
            serde_json::json!({"type": "thread.started"}),
            serde_json::json!({"type": "item.completed", "item": {"type": "agent_message", "text": "Reading files"}}),
            serde_json::json!({"type": "item.completed", "item": {"type": "agent_message", "text": review}}),
        );
        let result = parse_code_review_outcome(
            Uuid::nil(),
            AgentProvider::Codex,
            CodeReviewScope::RecentChanges,
            None,
            &raw,
            1,
        )
        .unwrap();
        assert_eq!(result.outcome, CodeReviewOutcome::Reviewed);
        assert_eq!(result.findings[0].file_path, "a.go");
        assert_eq!(result.findings[0].line, Some(7));
        assert_eq!(result.findings[0].suggested_comment.as_deref(), Some("Nit: rename `h` to handler?"));
    }

    #[test]
    fn joins_opencode_text_parts() {
        let raw = format!(
            "{}\n{}\n",
            serde_json::json!({"type": "text", "part": {"type": "text", "text": "{\"summary\":\"ok\","}}),
            serde_json::json!({"type": "text", "part": {"type": "text", "text": "\"findings\":[]}"}}),
        );
        assert_eq!(extract_agent_text(AgentProvider::OpenCode, &raw), "{\"summary\":\"ok\",\"findings\":[]}");
    }

    #[test]
    fn keeps_plain_text_as_an_unstructured_review() {
        let result = parse_code_review_outcome(
            Uuid::new_v4(),
            AgentProvider::Hermes,
            CodeReviewScope::TotalCode,
            None,
            "Looks fine.\nNo regressions.",
            9,
        )
        .unwrap();
        assert_eq!(result.outcome, CodeReviewOutcome::Unstructured);
        assert_eq!(result.summary, "Looks fine.\nNo regressions.");
        assert!(result.findings.is_empty());
        assert!(result.raw_output.is_some());
    }

    #[test]
    fn size_gate_ignores_lock_files_and_headers() {
        let patch = "diff --git a/src/a.go b/src/a.go\n--- a/src/a.go\n+++ b/src/a.go\n@@ -1,2 +1,2 @@\n-old\n+new\n ctx\ndiff --git a/go.sum b/go.sum\n--- a/go.sum\n+++ b/go.sum\n@@ -1 +1,3 @@\n+x\n+y\n+z\n";
        assert_eq!(count_reviewable_changed_lines(patch), 2);
    }

    #[test]
    fn strict_mode_covers_system_repositories_and_backend_files() {
        assert_eq!(raptik_strictness("core-dhcp", ""), CodeReviewStrictness::Strict);
        assert_eq!(raptik_strictness("storefront", "+++ b/src/app.tsx\n"), CodeReviewStrictness::Normal);
        assert_eq!(raptik_strictness("asset-status", "+++ b/handler.go\n"), CodeReviewStrictness::Strict);
    }

    #[test]
    fn skill_prompt_embeds_the_skill_references_and_mr_version_and_bounds_the_patch() {
        let repository = CodeReviewRepository {
            repository_id: "repo".into(),
            repository_label: "senzu".into(),
            base_commit_oid: "a".repeat(40),
            head_commit_oid: "b".repeat(40),
            patch_sha256: "sha256:x".into(),
            changed_lines: 2,
            size_gate_exceeded: false,
            strictness: CodeReviewStrictness::Strict,
            patch_truncated: false,
            merge_request: Some(CodeReviewMergeRequest {
                iid: 41,
                base_commit_oid: "a".repeat(40),
                start_commit_oid: "a".repeat(40),
                head_commit_oid: "c".repeat(40),
            }),
        };
        let repositories = vec![(repository, "x".repeat(100))];
        let references = vec![("references/playbook.md".to_owned(), "Log the error before returning.".to_owned())];
        let prompt = build_skill_review_prompt(&SkillPromptInput {
            skill_id: "raptik-review",
            reviewer: Some("Pratik"),
            rules: "# Raptik Review\nFlag panics.",
            references: &references,
            precedents_available: true,
            size_gate_lines: Some(500),
            intent: "Workspace: PLAT-1",
            repositories: &repositories,
            scope: CodeReviewScope::RecentChanges,
            patch_budget: 40,
        });
        assert!(prompt.contains("<skill>\n# Raptik Review\nFlag panics.\n</skill>"));
        assert!(prompt.contains("<reference file=\"references/playbook.md\">\nLog the error before returning.\n</reference>"));
        assert!(prompt.contains("past comments from Pratik"));
        assert!(prompt.contains("size gate (500 lines)"));
        assert!(prompt.contains("mergeRequest=\"!41\""));
        assert!(prompt.contains("mode=\"strict\""));
        assert!(prompt.contains("truncated this patch at 40 of 100 bytes"));
        assert!(prompt.contains("\"suggestedComment\""));
        assert!(prompt.contains("label \"question\""));
    }
}
