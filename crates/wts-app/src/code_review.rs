use crate::{AgentProvider, LocalWtsError};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

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

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeReviewFinding {
    pub finding_id: String,
    pub severity: CodeReviewFindingSeverity,
    pub file_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    pub title: String,
    pub explanation: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suggested_patch: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeReviewActionableStep {
    pub step_number: u32,
    pub instruction: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceCodeReviewResult {
    pub workspace_id: Uuid,
    pub provider: AgentProvider,
    pub scope: CodeReviewScope,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    pub summary: String,
    pub findings: Vec<CodeReviewFinding>,
    pub actionable_steps: Vec<CodeReviewActionableStep>,
    pub reviewed_at_unix_ms: i64,
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
        "You are an expert AI code reviewer performing a structured CodeRabbit-style review.\n\
         Scope: {scope_instructions}\n\
         {model_note}\
         Workspace context:\n{context_summary}\n\n\
         Requirements:\n\
         1. Summarize the changes concisely with an overall risk assessment.\n\
         2. Identify concrete findings with severity ('critical', 'warning', or 'suggestion'), file path, line number where applicable, clear explanation, and optional suggested diff fix.\n\
         3. Provide numbered actionable steps for the developer to resolve detected issues.\n\
         Respond in JSON format conforming to the expected schema."
    )
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
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct JsonOutput {
        summary: Option<String>,
        findings: Option<Vec<CodeReviewFinding>>,
        actionable_steps: Option<Vec<CodeReviewActionableStep>>,
    }

    // Try finding JSON block in output
    let json_candidate = if let Some(start) = raw_output.find("```json") {
        let content = &raw_output[start + 7..];
        if let Some(end) = content.find("```") {
            &content[..end]
        } else {
            content
        }
    } else if let Some(start) = raw_output.find('{') {
        if let Some(end) = raw_output.rfind('}') {
            &raw_output[start..=end]
        } else {
            raw_output
        }
    } else {
        raw_output
    };

    if let Ok(parsed) = serde_json::from_str::<JsonOutput>(json_candidate.trim()) {
        let summary = parsed.summary.unwrap_or_else(|| {
            if raw_output.trim().is_empty() {
                "Code review completed with no issues identified.".to_string()
            } else {
                raw_output.lines().take(3).collect::<Vec<_>>().join(" ")
            }
        });
        Ok(WorkspaceCodeReviewResult {
            workspace_id,
            provider,
            scope,
            model: model.clone(),
            agent: model,
            summary,
            findings: parsed.findings.unwrap_or_default(),
            actionable_steps: parsed.actionable_steps.unwrap_or_default(),
            reviewed_at_unix_ms: timestamp_ms,
        })
    } else {
        // Fall back to plain text parsing
        let summary = if raw_output.trim().is_empty() {
            "Code review completed with no issues identified.".to_string()
        } else {
            raw_output.lines().take(3).collect::<Vec<_>>().join(" ")
        };
        Ok(WorkspaceCodeReviewResult {
            workspace_id,
            provider,
            scope,
            model: model.clone(),
            agent: model,
            summary,
            findings: Vec::new(),
            actionable_steps: Vec::new(),
            reviewed_at_unix_ms: timestamp_ms,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_structured_json_review() {
        let raw = r#"```json
{
  "summary": "Detected 1 potential null dereference and 1 missing test.",
  "findings": [
    {
      "findingId": "find-1",
      "severity": "warning",
      "filePath": "src/lib.rs",
      "line": 42,
      "title": "Unchecked Option unwrap",
      "explanation": "Calling unwrap() may panic if value is None.",
      "suggestedPatch": "if let Some(val) = opt { ... }"
    }
  ],
  "actionableSteps": [
    {
      "stepNumber": 1,
      "instruction": "Replace unwrap with match or ok_or."
    }
  ]
}
```"#;
        let result = parse_code_review_outcome(
            Uuid::new_v4(),
            AgentProvider::Codex,
            CodeReviewScope::RecentChanges,
            Some("gpt-4o".to_string()),
            raw,
            123456789,
        )
        .expect("successful parse");

        assert_eq!(
            result.summary,
            "Detected 1 potential null dereference and 1 missing test."
        );
        assert_eq!(result.model, Some("gpt-4o".to_string()));
        assert_eq!(result.agent, Some("gpt-4o".to_string()));
        assert_eq!(result.findings.len(), 1);
        assert_eq!(
            result.findings[0].severity,
            CodeReviewFindingSeverity::Warning
        );
        assert_eq!(result.findings[0].file_path, "src/lib.rs");
        assert_eq!(result.actionable_steps.len(), 1);
    }

    #[test]
    fn builds_prompt_with_optional_model() {
        let prompt_without_model =
            build_code_review_prompt(CodeReviewScope::RecentChanges, "mock diffs", None);
        assert!(!prompt_without_model.contains("Configured model"));

        let prompt_with_model = build_code_review_prompt(
            CodeReviewScope::RecentChanges,
            "mock diffs",
            Some("claude-3.7-sonnet"),
        );
        assert!(prompt_with_model.contains("Configured model: claude-3.7-sonnet"));
        assert!(prompt_with_model.contains("Focus specifically on recent modifications"));
    }

    #[test]
    fn parses_copilot_plain_text_review_outcome() {
        let raw = "Code review completed successfully.\nNo security regressions found.\nOverall health is good.";
        let result = parse_code_review_outcome(
            Uuid::new_v4(),
            AgentProvider::Copilot,
            CodeReviewScope::TotalCode,
            Some("claude-3.5-sonnet".to_string()),
            raw,
            987654321,
        )
        .expect("successful parse");

        assert_eq!(result.provider, AgentProvider::Copilot);
        assert_eq!(result.model, Some("claude-3.5-sonnet".to_string()));
        assert_eq!(result.agent, Some("claude-3.5-sonnet".to_string()));
        assert_eq!(result.scope, CodeReviewScope::TotalCode);
        assert_eq!(
            result.summary,
            "Code review completed successfully. No security regressions found. Overall health is good."
        );
        assert!(result.findings.is_empty());
    }
}
