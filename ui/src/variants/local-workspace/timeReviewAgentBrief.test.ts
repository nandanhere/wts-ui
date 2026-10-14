import { describe, expect, it } from "vitest";
import type {
  ActivityWatchDailyReview,
  JiraActiveIssueList,
} from "../../lib/wtsClient";
import {
  buildTimeReviewAgentBrief,
  buildTimeReviewCsv,
} from "./timeReviewAgentBrief";

const review: ActivityWatchDailyReview = {
  schemaVersion: 1,
  startedAtUnixMs: 1_785_402_000_000,
  endedAtUnixMs: 1_785_402_600_000,
  totalActiveSeconds: 600,
  sessions: [
    {
      id: "aw-01",
      kind: "coding",
      startedAtUnixMs: 1_785_402_000_000,
      endedAtUnixMs: 1_785_402_600_000,
      durationSeconds: 600,
      description: "Coding work",
      application: "Visual Studio Code",
      activityEvidence: 'wts-ui, "Time review"',
      sourceEventCount: 12,
    },
  ],
  detail: "Sanitized local review.",
};

const jira: JiraActiveIssueList = {
  schemaVersion: 1,
  issues: [
    {
      issueKey: "WTS-42",
      summary: "Make time review useful",
      status: "In Progress",
    },
  ],
  detail: "Assigned active issues.",
};

describe("time review agent brief", () => {
  it("serializes recognizable sanitized evidence as valid escaped CSV", () => {
    const csv = buildTimeReviewCsv(review);
    expect(csv).toContain("application,activity_evidence");
    expect(csv).toContain("Visual Studio Code");
    expect(csv).toContain('"wts-ui, ""Time review"""');
    expect(csv).not.toContain("[object Object]");
  });

  it("asks for review-only existing assignments or new-ticket drafts", () => {
    const brief = buildTimeReviewAgentBrief(review, jira);
    expect(brief).toContain("WTS-42 [In Progress]");
    expect(brief).toContain("existingIssueKey or newIssueDraft");
    expect(brief).toContain("Do not create tickets or worklogs");
    expect(brief).toContain("Account for every block_id exactly once");
    expect(brief).toContain("aw-01");
  });
});
