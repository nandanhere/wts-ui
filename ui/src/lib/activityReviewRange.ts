import type { ActivityWatchDailyReview, WorkspaceClient } from "./wtsClient";

const DAY_MS = 86_400_000;
/** Read long summaries in bounded daily requests. A failed day fails the whole summary. */
export async function loadActivityReviewRange(
  client: Pick<WorkspaceClient, "getActivityWatchDailyReview">,
  start: number,
  end: number,
): Promise<ActivityWatchDailyReview> {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start || end - start > 7 * DAY_MS) {
    throw new Error("Choose a summary period of up to seven days.");
  }
  if (end - start <= 2 * DAY_MS) return client.getActivityWatchDailyReview(start, end);
  const result: ActivityWatchDailyReview = {
    schemaVersion: 1, startedAtUnixMs: start, endedAtUnixMs: end,
    totalActiveSeconds: 0, sessions: [], detail: "Activity summary for the selected period.",
  };
  for (let from = start; from < end; from += DAY_MS) {
    const to = Math.min(from + DAY_MS, end);
    const day = await client.getActivityWatchDailyReview(from, to);
    if (day.startedAtUnixMs !== from || day.endedAtUnixMs !== to) {
      throw new Error("The activity response does not match the summary period.");
    }
    result.totalActiveSeconds += day.totalActiveSeconds;
    result.sessions.push(...day.sessions.map(session => ({ ...session, id: `${from}:${session.id}` })));
  }
  return result;
}
