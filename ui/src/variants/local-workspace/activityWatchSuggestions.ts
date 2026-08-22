import type {
  ActivityWatchSessionCandidate,
  JiraActiveIssue,
} from "../../lib/wtsClient";

export interface JiraSuggestion {
  issueKey: string;
  confidence: number;
  reason: string;
}

export function suggestJiraIssues(
  session: ActivityWatchSessionCandidate,
  issues: JiraActiveIssue[],
): JiraSuggestion[] {
  const exact = issues
    .find((issue) => issue.issueKey === session.jiraIssueKey);
  if (exact) {
    return [{
      issueKey: exact.issueKey,
      confidence: 100,
      reason: "Jira key detected in local activity",
    }];
  }
  const semantic = issues.find(
    (issue) => issue.issueKey === session.suggestedJiraIssueKey,
  );
  if (
    semantic &&
    session.jiraSuggestionConfidence !== undefined &&
    session.jiraSuggestionReason
  ) {
    return [{
      issueKey: semantic.issueKey,
      confidence: session.jiraSuggestionConfidence,
      reason: session.jiraSuggestionReason,
    }];
  }
  return [];
}
