import type {
  ActivityWatchSessionCandidate,
  JiraActiveIssue,
} from "../../lib/wtsClient";
import { suggestJiraIssues } from "./activityWatchSuggestions";

/** A set of unassigned activity blocks that probably belong to one Jira ticket. */
export interface JiraWorkGroup {
  issueKey: string;
  issueSummary: string;
  sessionIds: string[];
  totalSeconds: number;
  reason: string;
}

/** Words that appear in most window titles and say nothing about the task. */
const commonWords = new Set([
  "about", "after", "agent", "background", "browser", "chrome", "code", "coding",
  "default", "editor", "file", "files", "from", "google", "incognito", "into",
  "local", "main", "mozilla", "new", "safari", "studio", "task", "terminal",
  "that", "their", "this", "untitled", "visual", "window", "with", "work",
  "workspace", "your",
]);

/** A neighbor block counts as the same task when the gap is this short. */
const FOLLOW_ON_GAP_MS = 10 * 60_000;

function words(text: string) {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 4 && !commonWords.has(word) && !/^\d+$/.test(word)),
  );
}

function blockText(session: ActivityWatchSessionCandidate) {
  return [session.activityEvidence, session.description].filter(Boolean).join(" ");
}

/** Words that identify one task: they name one ticket and appear in only a few blocks. */
function distinctiveWords(
  sessions: readonly ActivityWatchSessionCandidate[],
  issues: readonly JiraActiveIssue[],
) {
  const issueCount = new Map<string, number>();
  for (const issue of issues) for (const word of words(issue.summary)) issueCount.set(word, (issueCount.get(word) ?? 0) + 1);
  const blockCount = new Map<string, number>();
  for (const session of sessions) for (const word of words(blockText(session))) blockCount.set(word, (blockCount.get(word) ?? 0) + 1);
  const blockLimit = Math.max(3, Math.ceil(sessions.length * 0.15));
  return (word: string) => issueCount.get(word) === 1 && (blockCount.get(word) ?? 0) <= blockLimit;
}

function bestTextMatch(
  session: ActivityWatchSessionCandidate,
  issues: readonly JiraActiveIssue[],
  isDistinctive: (word: string) => boolean,
) {
  const text = blockText(session);
  const sessionWords = words(text);
  let best: { issue: JiraActiveIssue; shared: string[] } | null = null;
  for (const issue of issues) {
    if (new RegExp("\\b" + issue.issueKey + "\\b", "i").test(text)) {
      return { issue, reason: "Jira key in the window title" };
    }
    const shared = [...words(issue.summary)].filter((word) => sessionWords.has(word) && isDistinctive(word));
    if (shared.length >= 2 && (!best || shared.length > best.shared.length)) best = { issue, shared };
  }
  return best
    ? { issue: best.issue, reason: "Shares " + best.shared.slice(0, 3).map((word) => "“" + word + "”").join(", ") + " with the ticket" }
    : null;
}

/**
 * Groups blocks without a Jira ticket by the ticket they most likely belong to.
 * It uses only local text and timing. No model call and no network request.
 */
export function groupUnassignedWork(
  sessions: readonly ActivityWatchSessionCandidate[],
  issues: readonly JiraActiveIssue[],
  assignments: Readonly<Record<string, string>>,
): JiraWorkGroup[] {
  if (issues.length === 0) return [];
  const issueByKey = new Map(issues.map((issue) => [issue.issueKey, issue]));
  const ordered = [...sessions].sort((left, right) => left.startedAtUnixMs - right.startedAtUnixMs);

  const isDistinctive = distinctiveWords(ordered, issues);
  const picks = new Map<string, { issueKey: string; reason: string }>();
  // Only a ticket the user chose, or a Jira key in the window title, can lead a neighbor block.
  const anchors = new Map<string, string>();
  for (const session of ordered) {
    if (session.id in assignments) {
      if (assignments[session.id]) anchors.set(session.id, assignments[session.id]!);
      continue;
    }
    const titleKey = issues.find((issue) => new RegExp("\\b" + issue.issueKey + "\\b", "i").test(blockText(session)));
    if (titleKey) {
      anchors.set(session.id, titleKey.issueKey);
      picks.set(session.id, { issueKey: titleKey.issueKey, reason: "Jira key in the window title" });
      continue;
    }
    // A block that already shows a per-row suggestion joins that ticket, so one action confirms all of them.
    const suggested = suggestJiraIssues(session, [...issues])[0];
    if (suggested) {
      picks.set(session.id, { issueKey: suggested.issueKey, reason: "Matches the ticket summary" });
      continue;
    }
    const match = bestTextMatch(session, issues, isDistinctive);
    if (match) picks.set(session.id, { issueKey: match.issue.issueKey, reason: match.reason });
  }

  // Blocks in the same application right after an anchored block likely continue that task.
  // Guesses do not lead, so one guess does not spread along a chain of blocks.
  for (let index = 1; index < ordered.length; index += 1) {
    const session = ordered[index]!;
    if (session.id in assignments || picks.has(session.id)) continue;
    const previous = ordered[index - 1]!;
    const previousKey = anchors.get(previous.id);
    if (
      previousKey &&
      issueByKey.has(previousKey) &&
      previous.application &&
      previous.application === session.application &&
      session.startedAtUnixMs - previous.endedAtUnixMs <= FOLLOW_ON_GAP_MS
    ) {
      picks.set(session.id, { issueKey: previousKey, reason: "Same application, right after work on " + previousKey });
    }
  }

  const groups = new Map<string, JiraWorkGroup>();
  for (const session of ordered) {
    const pick = picks.get(session.id);
    if (!pick) continue;
    const issue = issueByKey.get(pick.issueKey)!;
    const group = groups.get(pick.issueKey) ?? {
      issueKey: pick.issueKey,
      issueSummary: issue.summary,
      sessionIds: [],
      totalSeconds: 0,
      reason: pick.reason,
    };
    group.sessionIds.push(session.id);
    group.totalSeconds += session.durationSeconds;
    groups.set(pick.issueKey, group);
  }
  return [...groups.values()].sort((left, right) => right.totalSeconds - left.totalSeconds);
}
