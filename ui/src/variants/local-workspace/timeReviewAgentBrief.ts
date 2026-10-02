import type {
  ActivityWatchDailyReview,
  JiraActiveIssueList,
} from "../../lib/wtsClient";

function csvCell(value: string | number) {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function isoTime(value: number) {
  return new Date(value).toISOString();
}

export function buildTimeReviewCsv(review: ActivityWatchDailyReview) {
  const header = [
    "block_id",
    "started_at",
    "ended_at",
    "duration_seconds",
    "activity_type",
    "application",
    "activity_evidence",
    "detected_jira_key",
    "source_event_count",
  ];
  const rows = review.sessions.map((session) => [
    session.id,
    isoTime(session.startedAtUnixMs),
    isoTime(session.endedAtUnixMs),
    session.durationSeconds,
    session.kind,
    session.application ?? "",
    session.activityEvidence ?? session.description,
    session.jiraIssueKey ?? "",
    session.sourceEventCount,
  ]);
  return [header, ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\n");
}

export function buildTimeReviewAgentBrief(
  review: ActivityWatchDailyReview,
  jira: JiraActiveIssueList,
) {
  const issues = jira.issues.length
    ? jira.issues
        .map(
          (issue) =>
            `- ${issue.issueKey} [${issue.status}]: ${issue.summary}`,
        )
        .join("\n")
    : "- No currently assigned active issues were returned.";
  return [
    "Review today's local ActivityWatch ledger and propose Jira attribution.",
    "",
    "Rules:",
    "- Treat the CSV as activity evidence, not as a transcript.",
    "- Prefer an assigned active Jira issue only when the evidence supports it.",
    "- Keep uncertain blocks unassigned.",
    "- When coherent work is not covered by an assigned issue, propose a new Jira ticket with project, summary, description, and acceptance criteria.",
    "- Do not create tickets or worklogs. Return proposals for user review.",
    "- Account for every block_id exactly once.",
    "",
    "Assigned active Jira issues:",
    issues,
    "",
    "Return JSON with schemaVersion 1 and a proposals array. Each proposal must contain blockIds, confidence, rationale, and exactly one of existingIssueKey or newIssueDraft.",
    "",
    "Activity ledger (CSV):",
    "```csv",
    buildTimeReviewCsv(review),
    "```",
  ].join("\n");
}
