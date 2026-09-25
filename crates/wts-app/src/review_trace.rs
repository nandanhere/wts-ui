//! Live steps of an AI code review run, for the review card.

use crate::AgentProvider;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, VecDeque},
    fmt,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

const MAX_STEPS: usize = 400;
const MAX_STEP_TEXT_CHARS: usize = 600;
const MAX_STEP_DETAIL_CHARS: usize = 2_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CodeReviewTraceKind {
    Status,
    Thinking,
    Message,
    Command,
    Tool,
    Search,
    Error,
}

/// One readable step of the agent run.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeReviewTraceStep {
    pub sequence: u32,
    pub kind: CodeReviewTraceKind,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
    /// True while a command or tool is still in progress.
    #[serde(default)]
    pub running: bool,
    pub at_unix_ms: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CodeReviewRunState {
    Running,
    Finished,
    Failed,
}

/// The steps of the current or last review run of a workspace.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeReviewTrace {
    pub workspace_id: Uuid,
    pub run_id: Uuid,
    pub provider: AgentProvider,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub state: CodeReviewRunState,
    pub started_at_unix_ms: i64,
    pub steps: Vec<CodeReviewTraceStep>,
    /// The number of old steps that WTS removed to keep the trace small.
    pub dropped_steps: u32,
}

/// A step from the parser, before the store gives it a sequence number.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ParsedStep {
    pub kind: CodeReviewTraceKind,
    pub text: String,
    pub detail: Option<String>,
    pub item_id: Option<String>,
    pub running: bool,
}

#[derive(Clone)]
pub(crate) struct ReviewTraceSink(Arc<dyn Fn(ParsedStep) + Send + Sync>);

impl ReviewTraceSink {
    pub(crate) fn new(sink: impl Fn(ParsedStep) + Send + Sync + 'static) -> Self {
        Self(Arc::new(sink))
    }
}

impl std::ops::Deref for ReviewTraceSink {
    type Target = dyn Fn(ParsedStep) + Send + Sync;
    fn deref(&self) -> &Self::Target {
        self.0.as_ref()
    }
}

impl fmt::Debug for ReviewTraceSink {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ReviewTraceSink")
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as i64)
}

fn clip(text: &str, maximum: usize) -> String {
    let cleaned = text
        .chars()
        .filter(|character| !character.is_control() || *character == '\n' || *character == '\t')
        .collect::<String>();
    let trimmed = cleaned.trim();
    if trimmed.chars().count() <= maximum {
        return trimmed.to_owned();
    }
    let mut clipped = trimmed.chars().take(maximum).collect::<String>();
    clipped.push('…');
    clipped
}

fn step(kind: CodeReviewTraceKind, text: impl AsRef<str>) -> ParsedStep {
    ParsedStep {
        kind,
        text: clip(text.as_ref(), MAX_STEP_TEXT_CHARS),
        detail: None,
        item_id: None,
        running: false,
    }
}

/// A shell command without the "bash -lc" wrapper that Codex adds.
fn readable_command(command: &str) -> String {
    let trimmed = command.trim();
    for prefix in ["/bin/bash -lc ", "/bin/zsh -lc ", "bash -lc ", "zsh -lc ", "/bin/sh -c ", "sh -c "] {
        if let Some(rest) = trimmed.strip_prefix(prefix) {
            let rest = rest.trim();
            let unquoted = rest
                .strip_prefix('\'')
                .and_then(|value| value.strip_suffix('\''))
                .or_else(|| rest.strip_prefix('"').and_then(|value| value.strip_suffix('"')));
            return unquoted.unwrap_or(rest).to_owned();
        }
    }
    trimmed.to_owned()
}

/// True when the agent message is the final review JSON. The card shows the result, so the trace skips it.
fn is_review_payload(text: &str) -> bool {
    let trimmed = text.trim();
    (trimmed.starts_with('{') || trimmed.starts_with("```")) && trimmed.contains("\"findings\"")
}

/// Turns one stdout line of an agent into readable steps. It does not read secrets or tool output bodies.
pub(crate) fn parse_review_line(provider: AgentProvider, line: &[u8]) -> Vec<ParsedStep> {
    let text = String::from_utf8_lossy(line);
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    match provider {
        AgentProvider::Codex => serde_json::from_str::<Value>(trimmed)
            .map(|event| parse_codex(&event))
            .unwrap_or_default(),
        AgentProvider::OpenCode => serde_json::from_str::<Value>(trimmed)
            .map(|event| parse_open_code(&event))
            .unwrap_or_default(),
        AgentProvider::Copilot | AgentProvider::Hermes => {
            if is_review_payload(trimmed) || trimmed.starts_with('{') || trimmed.starts_with('"') {
                Vec::new()
            } else {
                vec![step(CodeReviewTraceKind::Message, trimmed)]
            }
        }
    }
}

fn parse_codex(event: &Value) -> Vec<ParsedStep> {
    let event_type = event["type"].as_str().unwrap_or_default();
    match event_type {
        "thread.started" => vec![step(CodeReviewTraceKind::Status, "Codex started.")],
        "turn.started" => vec![step(CodeReviewTraceKind::Status, "Codex reads the review request.")],
        "turn.completed" => {
            let mut done = step(CodeReviewTraceKind::Status, "Codex finished the review.");
            let usage = &event["usage"];
            if let (Some(input), Some(output)) = (usage["input_tokens"].as_u64(), usage["output_tokens"].as_u64()) {
                done.detail = Some(format!("{input} input tokens · {output} output tokens"));
            }
            vec![done]
        }
        "turn.failed" | "error" => {
            let message = event["error"]["message"]
                .as_str()
                .or_else(|| event["message"].as_str())
                .unwrap_or("Codex reported an error.");
            vec![step(CodeReviewTraceKind::Error, message)]
        }
        "item.started" | "item.updated" | "item.completed" => {
            let item = &event["item"];
            let item_id = item["id"].as_str().map(str::to_owned);
            let completed = event_type == "item.completed";
            let mut parsed = match item["type"].as_str().unwrap_or_default() {
                "agent_message" if completed => {
                    let text = item["text"].as_str().unwrap_or_default();
                    if text.trim().is_empty() {
                        return Vec::new();
                    }
                    if is_review_payload(text) {
                        step(CodeReviewTraceKind::Status, "Codex wrote the findings.")
                    } else {
                        step(CodeReviewTraceKind::Message, text)
                    }
                }
                "reasoning" if completed => {
                    let text = item["text"].as_str().or_else(|| item["summary"].as_str()).unwrap_or_default();
                    if text.trim().is_empty() {
                        step(CodeReviewTraceKind::Thinking, "Codex thinks about the change.")
                    } else {
                        step(CodeReviewTraceKind::Thinking, text.trim_matches('*'))
                    }
                }
                "command_execution" => {
                    let command = readable_command(item["command"].as_str().unwrap_or_default());
                    let mut parsed = step(CodeReviewTraceKind::Command, &command);
                    parsed.running = !completed;
                    if completed {
                        let exit = item["exit_code"].as_i64();
                        let output = item["aggregated_output"].as_str().unwrap_or_default();
                        let lines = output.lines().count();
                        parsed.detail = Some(match exit {
                            Some(0) | None => format!("{lines} lines of output"),
                            Some(code) => format!("Exit code {code} · {lines} lines of output"),
                        });
                    }
                    parsed
                }
                "web_search" => {
                    let query = item["query"].as_str().unwrap_or("the web");
                    let mut parsed = step(CodeReviewTraceKind::Search, format!("Search: {query}"));
                    parsed.running = !completed;
                    parsed
                }
                "mcp_tool_call" | "tool_call" => {
                    let server = item["server"].as_str().unwrap_or_default();
                    let tool = item["tool"].as_str().or_else(|| item["name"].as_str()).unwrap_or("a tool");
                    let label = if server.is_empty() { tool.to_owned() } else { format!("{server} · {tool}") };
                    let mut parsed = step(CodeReviewTraceKind::Tool, label);
                    parsed.running = !completed;
                    parsed
                }
                "todo_list" => {
                    let items = item["items"]
                        .as_array()
                        .map(|items| {
                            items
                                .iter()
                                .filter_map(|entry| {
                                    let text = entry["text"].as_str()?;
                                    let mark = if entry["completed"].as_bool() == Some(true) { "✓" } else { "○" };
                                    Some(format!("{mark} {text}"))
                                })
                                .collect::<Vec<_>>()
                                .join("\n")
                        })
                        .unwrap_or_default();
                    if items.is_empty() {
                        return Vec::new();
                    }
                    let mut parsed = step(CodeReviewTraceKind::Status, "Plan");
                    parsed.detail = Some(clip(&items, MAX_STEP_DETAIL_CHARS));
                    parsed
                }
                "error" => step(
                    CodeReviewTraceKind::Error,
                    item["message"].as_str().unwrap_or("Codex reported an error."),
                ),
                _ => return Vec::new(),
            };
            parsed.item_id = item_id;
            vec![parsed]
        }
        _ => Vec::new(),
    }
}

fn parse_open_code(event: &Value) -> Vec<ParsedStep> {
    let part = &event["part"];
    match event["type"].as_str().unwrap_or_default() {
        "step_start" => vec![step(CodeReviewTraceKind::Status, "OpenCode starts a step.")],
        "text" => {
            let text = part["text"].as_str().unwrap_or_default();
            if text.trim().is_empty() || is_review_payload(text) {
                Vec::new()
            } else {
                vec![step(CodeReviewTraceKind::Message, text)]
            }
        }
        "reasoning" => {
            let text = part["text"].as_str().unwrap_or("OpenCode thinks about the change.");
            vec![step(CodeReviewTraceKind::Thinking, text)]
        }
        "tool_use" => {
            let tool = part["tool"].as_str().unwrap_or("a tool");
            let title = part["state"]["title"].as_str().unwrap_or_default();
            let label = if title.is_empty() { tool.to_owned() } else { format!("{tool} · {title}") };
            let mut parsed = step(CodeReviewTraceKind::Tool, label);
            parsed.running = part["state"]["status"].as_str().is_some_and(|status| status != "completed" && status != "error");
            parsed.item_id = part["callID"].as_str().or_else(|| part["id"].as_str()).map(str::to_owned);
            vec![parsed]
        }
        "error" => {
            let message = event["error"]["data"]["message"]
                .as_str()
                .or_else(|| event["error"]["message"].as_str())
                .unwrap_or("OpenCode reported an error.");
            vec![step(CodeReviewTraceKind::Error, message)]
        }
        _ => Vec::new(),
    }
}

/// Keeps the live trace of the newest review run for each workspace.
#[derive(Clone, Default)]
pub(crate) struct CodeReviewTraceStore {
    inner: Arc<Mutex<BTreeMap<Uuid, CodeReviewTrace>>>,
}

impl CodeReviewTraceStore {
    pub(crate) fn begin(&self, workspace_id: Uuid, provider: AgentProvider, model: Option<String>) -> Uuid {
        let run_id = Uuid::new_v4();
        if let Ok(mut traces) = self.inner.lock() {
            traces.insert(
                workspace_id,
                CodeReviewTrace {
                    workspace_id,
                    run_id,
                    provider,
                    model,
                    state: CodeReviewRunState::Running,
                    started_at_unix_ms: now_ms(),
                    steps: Vec::new(),
                    dropped_steps: 0,
                },
            );
        }
        run_id
    }

    pub(crate) fn push(&self, workspace_id: Uuid, run_id: Uuid, parsed: ParsedStep) {
        let Ok(mut traces) = self.inner.lock() else { return };
        let Some(trace) = traces.get_mut(&workspace_id).filter(|trace| trace.run_id == run_id) else {
            return;
        };
        if let Some(item_id) = parsed.item_id.as_deref()
            && let Some(existing) = trace
                .steps
                .iter_mut()
                .rev()
                .find(|existing| existing.item_id.as_deref() == Some(item_id) && existing.kind == parsed.kind)
        {
            existing.text = parsed.text;
            existing.detail = parsed.detail.or(existing.detail.take());
            existing.running = parsed.running;
            return;
        }
        let sequence = trace.dropped_steps + trace.steps.len() as u32 + 1;
        let mut steps = VecDeque::from(std::mem::take(&mut trace.steps));
        steps.push_back(CodeReviewTraceStep {
            sequence,
            kind: parsed.kind,
            text: parsed.text,
            detail: parsed.detail,
            item_id: parsed.item_id,
            running: parsed.running,
            at_unix_ms: now_ms(),
        });
        while steps.len() > MAX_STEPS {
            steps.pop_front();
            trace.dropped_steps += 1;
        }
        trace.steps = steps.into();
    }

    pub(crate) fn finish(&self, workspace_id: Uuid, run_id: Uuid, succeeded: bool) {
        let Ok(mut traces) = self.inner.lock() else { return };
        if let Some(trace) = traces.get_mut(&workspace_id).filter(|trace| trace.run_id == run_id) {
            trace.state = if succeeded { CodeReviewRunState::Finished } else { CodeReviewRunState::Failed };
            for step in &mut trace.steps {
                step.running = false;
            }
        }
    }

    /// Returns the trace. With `after`, it returns only the steps with a larger sequence number.
    pub(crate) fn get(&self, workspace_id: Uuid, after: Option<u32>) -> Option<CodeReviewTrace> {
        let traces = self.inner.lock().ok()?;
        let mut trace = traces.get(&workspace_id)?.clone();
        if let Some(after) = after {
            trace.steps.retain(|step| step.sequence > after || step.running);
        }
        Some(trace)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn codex(line: &str) -> Vec<ParsedStep> {
        parse_review_line(AgentProvider::Codex, line.as_bytes())
    }

    #[test]
    fn codex_events_become_readable_steps() {
        let started = codex(r#"{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/bin/bash -lc 'rg -n cfg src'","aggregated_output":"","exit_code":null,"status":"in_progress"}}"#);
        assert_eq!(started[0].kind, CodeReviewTraceKind::Command);
        assert_eq!(started[0].text, "rg -n cfg src");
        assert!(started[0].running);
        let done = codex(r#"{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/bin/bash -lc 'rg -n cfg src'","aggregated_output":"a\nb\n","exit_code":0}}"#);
        assert_eq!(done[0].detail.as_deref(), Some("2 lines of output"));
        assert!(!done[0].running);
        let message = codex(r#"{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I'll check the nil path first."}}"#);
        assert_eq!(message[0].kind, CodeReviewTraceKind::Message);
        let payload = codex(r#"{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"{\"summary\":\"x\",\"findings\":[]}"}}"#);
        assert_eq!(payload[0].text, "Codex wrote the findings.");
        assert!(codex("not json").is_empty());
        assert!(codex(r#"{"type":"item.completed","item":{"type":"unknown"}}"#).is_empty());
    }

    #[test]
    fn open_code_tools_and_text_become_steps() {
        let tool = parse_review_line(
            AgentProvider::OpenCode,
            br#"{"type":"tool_use","part":{"type":"tool","tool":"read","callID":"c1","state":{"status":"running","title":"src/a.rs","output":"PRIVATE"}}}"#,
        );
        assert_eq!(tool[0].text, "read · src/a.rs");
        assert!(tool[0].running);
        assert!(!format!("{tool:?}").contains("PRIVATE"));
    }

    #[test]
    fn the_store_updates_items_in_place_and_returns_only_new_steps() {
        let store = CodeReviewTraceStore::default();
        let workspace = Uuid::new_v4();
        let run = store.begin(workspace, AgentProvider::Codex, None);
        for line in [
            r#"{"type":"turn.started"}"#,
            r#"{"type":"item.started","item":{"id":"i1","type":"command_execution","command":"ls"}}"#,
            r#"{"type":"item.completed","item":{"id":"i1","type":"command_execution","command":"ls","aggregated_output":"x\n","exit_code":0}}"#,
        ] {
            for parsed in codex(line) {
                store.push(workspace, run, parsed);
            }
        }
        let trace = store.get(workspace, None).unwrap();
        assert_eq!(trace.steps.len(), 2);
        assert!(!trace.steps[1].running);
        assert_eq!(store.get(workspace, Some(1)).unwrap().steps.len(), 1);
        store.push(workspace, Uuid::new_v4(), step(CodeReviewTraceKind::Status, "stale run"));
        assert_eq!(store.get(workspace, None).unwrap().steps.len(), 2);
        store.finish(workspace, run, true);
        assert_eq!(store.get(workspace, None).unwrap().state, CodeReviewRunState::Finished);
    }
}
