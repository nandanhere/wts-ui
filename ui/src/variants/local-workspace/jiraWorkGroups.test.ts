import { describe, expect, it } from "vitest";
import type { ActivityWatchSessionCandidate, JiraActiveIssue } from "../../lib/wtsClient";
import { groupUnassignedWork } from "./jiraWorkGroups";

const base = 1_785_402_000_000;
const block = (id: string, minute: number, text: string, application = "Google Chrome"): ActivityWatchSessionCandidate => ({
  id,
  kind: "browser",
  startedAtUnixMs: base + minute * 60_000,
  endedAtUnixMs: base + (minute + 5) * 60_000,
  durationSeconds: 300,
  description: "Browser research",
  activityEvidence: text,
  application,
  sourceEventCount: 1,
});

const issues: JiraActiveIssue[] = [
  { issueKey: "DEVTOOLS-7356", summary: "Remove boot order health checks from validation", status: "In Progress" },
  { issueKey: "DEVTOOLS-7510", summary: "Parse single-neighbor LLDP JSON for provisioning VLAN", status: "Open" },
];

describe("groupUnassignedWork", () => {
  it("groups blocks by the ticket whose words they share, and leaves unrelated blocks alone", () => {
    const groups = groupUnassignedWork([
      block("a", 0, "LLDP neighbor parsing - provisioning docs"),
      block("b", 30, "Boot order health checks runbook"),
      block("c", 60, "Afnan supremacy CE liquid brun hawas ice r/DesiFragranceAddicts - Google Chrome Incognito"),
      block("d", 90, "VLAN provisioning LLDP examples"),
    ], issues, {});

    expect(groups.map((group) => group.issueKey)).toEqual(["DEVTOOLS-7510", "DEVTOOLS-7356"]);
    expect(groups[0]).toMatchObject({ sessionIds: ["a", "d"], totalSeconds: 600 });
    expect(groups.flatMap((group) => group.sessionIds)).not.toContain("c");
  });

  it("adds a follow-on block in the same application to the ticket the user just worked on", () => {
    const groups = groupUnassignedWork([
      block("a", 0, "Merge request !640", "Visual Studio Code"),
      block("b", 7, "handler.go", "Visual Studio Code"),
      block("c", 40, "handler_test.go", "Visual Studio Code"),
    ], issues, { a: "DEVTOOLS-7356" });

    expect(groups).toEqual([expect.objectContaining({ issueKey: "DEVTOOLS-7356", sessionIds: ["b"] })]);
    expect(groups[0]!.reason).toContain("right after work on DEVTOOLS-7356");
  });

  it("does not suggest a ticket for a block the user left unassigned on purpose", () => {
    expect(groupUnassignedWork([block("a", 0, "LLDP provisioning")], issues, { a: "" })).toEqual([]);
  });

  it("collects blocks that already show a per-row suggestion, so one action confirms them all", () => {
    const suggested = (id: string, minute: number) => ({
      ...block(id, minute, "beacon-flow Workspace", "Code"),
      suggestedJiraIssueKey: "DEVTOOLS-7356",
      jiraSuggestionConfidence: 80,
      jiraSuggestionReason: "Activity context matches 2 distinctive words in the Jira summary",
    });
    const groups = groupUnassignedWork([suggested("a", 0), suggested("b", 30), suggested("c", 60)], issues, { c: "DEVTOOLS-7356" });
    expect(groups).toEqual([expect.objectContaining({ issueKey: "DEVTOOLS-7356", sessionIds: ["a", "b"] })]);
  });

  it("ignores a word that appears in many window titles, such as the company name", () => {
    const sessions = Array.from({ length: 12 }, (_, index) =>
      block("b" + index, index * 10, "Acme Systems portal page " + index));
    const groups = groupUnassignedWork(sessions, [
      { issueKey: "OPS-10097", summary: "BMC not accessible - Acme systems portal", status: "Open" },
      ...issues,
    ], {});
    expect(groups).toEqual([]);
  });
});
