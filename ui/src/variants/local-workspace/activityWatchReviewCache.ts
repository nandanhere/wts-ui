import type {
  ActivityWatchDailyReview,
  ActivityWatchSessionCandidate,
  ActivityWatchSessionKind,
  JiraActiveIssue,
  JiraActiveIssueList,
} from "../../lib/wtsClient";

const CACHE_SCHEMA_VERSION = 1;
const CACHE_KEY_PREFIX = "wts.activity-watch-review.v1";
const HISTORY_CACHE_SCHEMA_VERSION = 1;
const HISTORY_CACHE_KEY = "wts.activity-watch-review-history.v1";
const MAX_REVIEW_SESSIONS = 2_000;
const MAX_JIRA_ISSUES = 500;
const MAX_ASSIGNMENTS = 2_000;
const MAX_TEXT_LENGTH = 2_000;
const MAX_HISTORY_SNAPSHOTS = 32;
const MAX_HISTORY_SERIALIZED_BYTES = 512 * 1_024;

const sessionKinds = new Set<ActivityWatchSessionKind>([
  "coding",
  "agent",
  "browser",
  "communication",
  "terminal",
  "other",
]);

export interface ActivityWatchReviewSnapshot {
  schemaVersion: 1;
  dateKey: string;
  builtAtUnixMs: number;
  review: ActivityWatchDailyReview;
  jiraIssues: JiraActiveIssueList;
  assignments: Record<string, string>;
}

export interface ActivityWatchReviewIntervalSnapshot {
  schemaVersion: 1;
  intervalId: string;
  source: "automatic";
  startedAtUnixMs: number;
  endedAtUnixMs: number;
  builtAtUnixMs: number;
  review: ActivityWatchDailyReview;
  jiraIssues: JiraActiveIssueList;
}

interface ActivityWatchReviewHistory {
  schemaVersion: 1;
  snapshots: ActivityWatchReviewIntervalSnapshot[];
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown, minimum = 0): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= minimum
  );
}

function safeUnixMs(value: unknown): value is number {
  return finiteNumber(value) && Number.isSafeInteger(value);
}

function boundedText(value: unknown, allowEmpty = false): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_TEXT_LENGTH &&
    (allowEmpty || value.trim().length > 0)
  );
}

function optionalBoundedText(value: unknown): value is string | undefined {
  return value === undefined || boundedText(value);
}

function optionalFiniteNumber(value: unknown): value is number | undefined {
  return value === undefined || finiteNumber(value);
}

function validSession(value: unknown): value is ActivityWatchSessionCandidate {
  const candidate = record(value);
  return Boolean(
    candidate &&
      boundedText(candidate.id) &&
      typeof candidate.kind === "string" &&
      sessionKinds.has(candidate.kind as ActivityWatchSessionKind) &&
      finiteNumber(candidate.startedAtUnixMs) &&
      finiteNumber(candidate.endedAtUnixMs) &&
      candidate.endedAtUnixMs >= candidate.startedAtUnixMs &&
      finiteNumber(candidate.durationSeconds) &&
      boundedText(candidate.description) &&
      optionalBoundedText(candidate.application) &&
      optionalBoundedText(candidate.activityEvidence) &&
      optionalBoundedText(candidate.jiraIssueKey) &&
      optionalBoundedText(candidate.suggestedJiraIssueKey) &&
      optionalFiniteNumber(candidate.jiraSuggestionConfidence) &&
      optionalBoundedText(candidate.jiraSuggestionReason) &&
      Number.isInteger(candidate.sourceEventCount) &&
      finiteNumber(candidate.sourceEventCount),
  );
}

function validReview(value: unknown): value is ActivityWatchDailyReview {
  const review = record(value);
  return Boolean(
    review &&
      review.schemaVersion === 1 &&
      safeUnixMs(review.startedAtUnixMs) &&
      safeUnixMs(review.endedAtUnixMs) &&
      review.endedAtUnixMs >= review.startedAtUnixMs &&
      finiteNumber(review.totalActiveSeconds) &&
      Array.isArray(review.sessions) &&
      review.sessions.length <= MAX_REVIEW_SESSIONS &&
      review.sessions.every(validSession) &&
      boundedText(review.detail, true),
  );
}

function validJiraIssue(value: unknown): value is JiraActiveIssue {
  const issue = record(value);
  return Boolean(
    issue &&
      boundedText(issue.issueKey) &&
      boundedText(issue.summary) &&
      boundedText(issue.status),
  );
}

function validJiraIssues(value: unknown): value is JiraActiveIssueList {
  const issues = record(value);
  return Boolean(
    issues &&
      issues.schemaVersion === 1 &&
      Array.isArray(issues.issues) &&
      issues.issues.length <= MAX_JIRA_ISSUES &&
      issues.issues.every(validJiraIssue) &&
      boundedText(issues.detail, true),
  );
}

function validAssignments(value: unknown): value is Record<string, string> {
  const assignments = record(value);
  if (!assignments) return false;
  const entries = Object.entries(assignments);
  return (
    entries.length <= MAX_ASSIGNMENTS &&
    entries.every(
      ([sessionId, issueKey]) =>
        boundedText(sessionId) && boundedText(issueKey, true),
    )
  );
}

function sanitizedSession(
  session: ActivityWatchSessionCandidate,
): ActivityWatchSessionCandidate {
  return {
    id: session.id,
    kind: session.kind,
    startedAtUnixMs: session.startedAtUnixMs,
    endedAtUnixMs: session.endedAtUnixMs,
    durationSeconds: session.durationSeconds,
    description: session.description,
    ...(session.application === undefined
      ? {}
      : { application: session.application }),
    ...(session.activityEvidence === undefined
      ? {}
      : { activityEvidence: session.activityEvidence }),
    ...(session.jiraIssueKey === undefined
      ? {}
      : { jiraIssueKey: session.jiraIssueKey }),
    ...(session.suggestedJiraIssueKey === undefined
      ? {}
      : { suggestedJiraIssueKey: session.suggestedJiraIssueKey }),
    ...(session.jiraSuggestionConfidence === undefined
      ? {}
      : { jiraSuggestionConfidence: session.jiraSuggestionConfidence }),
    ...(session.jiraSuggestionReason === undefined
      ? {}
      : { jiraSuggestionReason: session.jiraSuggestionReason }),
    sourceEventCount: session.sourceEventCount,
  };
}

function sanitizedReview(review: ActivityWatchDailyReview): ActivityWatchDailyReview {
  return {
    schemaVersion: 1,
    startedAtUnixMs: review.startedAtUnixMs,
    endedAtUnixMs: review.endedAtUnixMs,
    totalActiveSeconds: review.totalActiveSeconds,
    sessions: review.sessions.map(sanitizedSession),
    detail: review.detail,
  };
}

function sanitizedJiraIssues(issues: JiraActiveIssueList): JiraActiveIssueList {
  return {
    schemaVersion: 1,
    issues: issues.issues.map((issue) => ({
      issueKey: issue.issueKey,
      summary: issue.summary,
      status: issue.status,
    })),
    detail: issues.detail,
  };
}

function sanitizedAssignments(assignments: Record<string, string>) {
  return Object.fromEntries(Object.entries(assignments));
}

function serializedBytes(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

export function activityWatchReviewIntervalId(
  startedAtUnixMs: number,
  endedAtUnixMs: number,
) {
  return `activity-watch:${startedAtUnixMs}:${endedAtUnixMs}`;
}

function validIntervalSnapshot(
  value: unknown,
): value is ActivityWatchReviewIntervalSnapshot {
  const snapshot = record(value);
  if (
    !snapshot ||
    snapshot.schemaVersion !== HISTORY_CACHE_SCHEMA_VERSION ||
    snapshot.source !== "automatic" ||
    !safeUnixMs(snapshot.startedAtUnixMs) ||
    !safeUnixMs(snapshot.endedAtUnixMs) ||
    snapshot.endedAtUnixMs <= snapshot.startedAtUnixMs ||
    snapshot.intervalId !==
      activityWatchReviewIntervalId(
        snapshot.startedAtUnixMs,
        snapshot.endedAtUnixMs,
      ) ||
    !safeUnixMs(snapshot.builtAtUnixMs) ||
    !validReview(snapshot.review) ||
    snapshot.review.startedAtUnixMs !== snapshot.startedAtUnixMs ||
    snapshot.review.endedAtUnixMs !== snapshot.endedAtUnixMs ||
    !validJiraIssues(snapshot.jiraIssues)
  ) {
    return false;
  }
  return true;
}

function sanitizedIntervalSnapshot(
  snapshot: ActivityWatchReviewIntervalSnapshot,
): ActivityWatchReviewIntervalSnapshot {
  return {
    schemaVersion: 1,
    intervalId: snapshot.intervalId,
    source: "automatic",
    startedAtUnixMs: snapshot.startedAtUnixMs,
    endedAtUnixMs: snapshot.endedAtUnixMs,
    builtAtUnixMs: snapshot.builtAtUnixMs,
    review: sanitizedReview(snapshot.review),
    jiraIssues: sanitizedJiraIssues(snapshot.jiraIssues),
  };
}

export function localDateKey(now = new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function cacheKey(dateKey: string) {
  return `${CACHE_KEY_PREFIX}:${dateKey}`;
}

export function loadActivityWatchReviewSnapshot(
  storage: Pick<Storage, "getItem" | "removeItem"> | undefined =
    globalThis.localStorage,
  dateKey = localDateKey(),
): ActivityWatchReviewSnapshot | null {
  if (!storage) return null;
  const key = cacheKey(dateKey);
  try {
    const serialized = storage.getItem(key);
    if (!serialized) return null;
    const value = record(JSON.parse(serialized));
    if (
      !value ||
      value.schemaVersion !== CACHE_SCHEMA_VERSION ||
      value.dateKey !== dateKey ||
      !finiteNumber(value.builtAtUnixMs) ||
      !validReview(value.review) ||
      !validJiraIssues(value.jiraIssues) ||
      !validAssignments(value.assignments)
    ) {
      storage.removeItem(key);
      return null;
    }
    return value as unknown as ActivityWatchReviewSnapshot;
  } catch {
    try {
      storage.removeItem(key);
    } catch {
      // Storage can be disabled; cache failures must not block the review.
    }
    return null;
  }
}

export function saveActivityWatchReviewSnapshot(
  snapshot: ActivityWatchReviewSnapshot,
  storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage,
) {
  if (!storage) return false;
  if (
    snapshot.schemaVersion !== CACHE_SCHEMA_VERSION ||
    !boundedText(snapshot.dateKey) ||
    !safeUnixMs(snapshot.builtAtUnixMs) ||
    !validReview(snapshot.review) ||
    !validJiraIssues(snapshot.jiraIssues) ||
    !validAssignments(snapshot.assignments)
  ) {
    return false;
  }
  try {
    storage.setItem(
      cacheKey(snapshot.dateKey),
      JSON.stringify({
        schemaVersion: 1,
        dateKey: snapshot.dateKey,
        builtAtUnixMs: snapshot.builtAtUnixMs,
        review: sanitizedReview(snapshot.review),
        jiraIssues: sanitizedJiraIssues(snapshot.jiraIssues),
        assignments: sanitizedAssignments(snapshot.assignments),
      } satisfies ActivityWatchReviewSnapshot),
    );
    return true;
  } catch {
    return false;
  }
}

export function loadActivityWatchReviewHistory(
  storage: Pick<Storage, "getItem" | "removeItem"> | undefined =
    globalThis.localStorage,
): ActivityWatchReviewIntervalSnapshot[] {
  if (!storage) return [];
  try {
    const serialized = storage.getItem(HISTORY_CACHE_KEY);
    if (!serialized) return [];
    if (serializedBytes(serialized) > MAX_HISTORY_SERIALIZED_BYTES) {
      storage.removeItem(HISTORY_CACHE_KEY);
      return [];
    }
    const history = record(JSON.parse(serialized));
    if (
      !history ||
      history.schemaVersion !== HISTORY_CACHE_SCHEMA_VERSION ||
      !Array.isArray(history.snapshots) ||
      history.snapshots.length > MAX_HISTORY_SNAPSHOTS ||
      !history.snapshots.every(validIntervalSnapshot)
    ) {
      storage.removeItem(HISTORY_CACHE_KEY);
      return [];
    }
    return history.snapshots as ActivityWatchReviewIntervalSnapshot[];
  } catch {
    try {
      storage.removeItem(HISTORY_CACHE_KEY);
    } catch {
      // Storage can be disabled; cache failures must not block the review.
    }
    return [];
  }
}

export function saveActivityWatchReviewHistorySnapshot(
  snapshot: ActivityWatchReviewIntervalSnapshot,
  storage: Pick<Storage, "getItem" | "removeItem" | "setItem"> | undefined =
    globalThis.localStorage,
) {
  if (!storage || !validIntervalSnapshot(snapshot)) return false;
  const safeSnapshot = sanitizedIntervalSnapshot(snapshot);
  const current = loadActivityWatchReviewHistory(storage);
  if (
    current.some(
      (item) =>
        item.intervalId !== safeSnapshot.intervalId &&
        safeSnapshot.startedAtUnixMs < item.endedAtUnixMs &&
        item.startedAtUnixMs < safeSnapshot.endedAtUnixMs,
    )
  ) {
    return false;
  }
  const snapshots = [
    safeSnapshot,
    ...current.filter((item) => item.intervalId !== safeSnapshot.intervalId),
  ]
    .sort(
      (left, right) =>
        right.endedAtUnixMs - left.endedAtUnixMs ||
        right.builtAtUnixMs - left.builtAtUnixMs ||
        right.intervalId.localeCompare(left.intervalId),
    )
    .slice(0, MAX_HISTORY_SNAPSHOTS);

  let serialized = JSON.stringify({
    schemaVersion: 1,
    snapshots,
  } satisfies ActivityWatchReviewHistory);
  while (
    snapshots.length > 1 &&
    serializedBytes(serialized) > MAX_HISTORY_SERIALIZED_BYTES
  ) {
    snapshots.pop();
    serialized = JSON.stringify({
      schemaVersion: 1,
      snapshots,
    } satisfies ActivityWatchReviewHistory);
  }
  if (
    !snapshots.some((item) => item.intervalId === safeSnapshot.intervalId) ||
    serializedBytes(serialized) > MAX_HISTORY_SERIALIZED_BYTES
  ) {
    return false;
  }

  try {
    storage.setItem(HISTORY_CACHE_KEY, serialized);
    return storage.getItem(HISTORY_CACHE_KEY) === serialized;
  } catch {
    return false;
  }
}
