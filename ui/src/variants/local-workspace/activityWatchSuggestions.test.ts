import { describe, expect, it } from "vitest";
import type {
  ActivityWatchSessionCandidate,
  JiraActiveIssue,
} from "../../lib/wtsClient";
import { suggestJiraIssues } from "./activityWatchSuggestions";

const session: ActivityWatchSessionCandidate = {
  id: "aw-0001",
  kind: "coding",
  startedAtUnixMs: 1_785_402_000_000,
  endedAtUnixMs: 1_785_403_200_000,
  durationSeconds: 1_200,
  description: "Coding work",
  sourceEventCount: 2,
};

const issues: JiraActiveIssue[] = [
  { issueKey: "OPS-41", summary: "Repair CI", status: "Open" },
  {
    issueKey: "PLATFORM-42",
    summary: "Retry duplicate captures",
    status: "In Progress",
  },
  { issueKey: "WEB-9", summary: "Tune dashboard", status: "Selected" },
];

describe("ActivityWatch Jira suggestions", () => {
  it("makes an exact locally detected key certain", () => {
    const suggestions = suggestJiraIssues(
      { ...session, jiraIssueKey: "OPS-41" },
      issues,
    );
    expect(suggestions[0]).toEqual({
      issueKey: "OPS-41",
      confidence: 100,
      reason: "Jira key detected in local activity",
    });
  });

  it("does not turn ticket status or workspace presence into activity evidence", () => {
    expect(suggestJiraIssues(session, issues)).toEqual([]);
  });

  it("does not suggest a detected key that is not in the assignable issue list", () => {
    expect(
      suggestJiraIssues(
        { ...session, jiraIssueKey: "UNKNOWN-9" },
        issues,
      ),
    ).toEqual([]);
  });

  it("uses a privacy-safe semantic match produced locally by WTS", () => {
    expect(
      suggestJiraIssues(
        {
          ...session,
          suggestedJiraIssueKey: "PLATFORM-42",
          jiraSuggestionConfidence: 84,
          jiraSuggestionReason:
            "Activity context matches 3 distinctive words in the Jira summary",
        },
        issues,
      ),
    ).toEqual([
      {
        issueKey: "PLATFORM-42",
        confidence: 84,
        reason:
          "Activity context matches 3 distinctive words in the Jira summary",
      },
    ]);
  });
});
