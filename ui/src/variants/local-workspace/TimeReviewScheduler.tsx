import { useEffect, useRef, useState } from "react";
import type { WorkspaceClient } from "../../lib/wtsClient";
import {
  activityWatchReviewIntervalId,
  localDateKey,
  saveActivityWatchReviewHistorySnapshot,
  saveActivityWatchReviewSnapshot,
} from "./activityWatchReviewCache";
import { sendDesktopNotification } from "./desktopNotifications";
import {
  announceTimeReviewSnapshot,
  completeScheduledTimeReview,
  loadTimeReviewSchedule,
  saveTimeReviewSchedule,
  scheduledTimeReview,
  subscribeTimeReviewSchedule,
} from "./timeReviewSchedule";

const AUTOMATIC_REVIEW_RETRY_MS = 5 * 60 * 1_000;
const MINIMUM_TIMER_DELAY_MS = 1_000;

type NotificationSender = typeof sendDesktopNotification;

export function TimeReviewScheduler({
  client,
  notify = sendDesktopNotification,
}: {
  client: WorkspaceClient;
  notify?: NotificationSender;
}) {
  const [schedule, setSchedule] = useState(loadTimeReviewSchedule);
  const generationRef = useRef(0);
  const runningRef = useRef(false);
  const lastAttemptAtRef = useRef(0);

  useEffect(() => {
    const syncSchedule = () => setSchedule(loadTimeReviewSchedule());
    const unsubscribe = subscribeTimeReviewSchedule(syncSchedule);
    const current = loadTimeReviewSchedule();
    if (current.startedAtUnixMs === 0) {
      saveTimeReviewSchedule({
        ...current,
        startedAtUnixMs: Date.now(),
      });
    }
    return unsubscribe;
  }, []);

  useEffect(() => {
    const generation = ++generationRef.current;
    let timer: number | undefined;

    const scheduleWake = (wakeAtUnixMs: number) => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(
        runWhenDue,
        Math.max(MINIMUM_TIMER_DELAY_MS, wakeAtUnixMs - Date.now()),
      );
    };

    const buildReview = async (
      startedAtUnixMs: number,
      endedAtUnixMs: number,
    ) => {
      runningRef.current = true;
      try {
        const activityStatus = await client.getActivityWatchStatus();
        if (
          generation !== generationRef.current ||
          activityStatus.state !== "running"
        ) {
          return;
        }
        const [reviewResult, jiraResult] = await Promise.allSettled([
          client.getActivityWatchDailyReview(startedAtUnixMs, endedAtUnixMs),
          client.listActiveJiraIssues(),
        ]);
        if (
          generation !== generationRef.current ||
          reviewResult.status !== "fulfilled" ||
          jiraResult.status !== "fulfilled"
        ) {
          return;
        }
        const builtAtUnixMs = Date.now();
        const historySaved = saveActivityWatchReviewHistorySnapshot({
          schemaVersion: 1,
          intervalId: activityWatchReviewIntervalId(
            startedAtUnixMs,
            endedAtUnixMs,
          ),
          source: "automatic",
          startedAtUnixMs,
          endedAtUnixMs,
          builtAtUnixMs,
          review: reviewResult.value,
          jiraIssues: jiraResult.value,
        });
        if (!historySaved) return;

        saveActivityWatchReviewSnapshot({
          schemaVersion: 1,
          dateKey: localDateKey(),
          builtAtUnixMs,
          review: reviewResult.value,
          jiraIssues: jiraResult.value,
          assignments: {},
        });

        const current = loadTimeReviewSchedule();
        const completed = completeScheduledTimeReview(current, endedAtUnixMs);
        if (!saveTimeReviewSchedule(completed)) return;
        announceTimeReviewSnapshot();
        if (completed.notificationsEnabled) {
          const blockCount = reviewResult.value.sessions.length;
          void notify(
            "My time summary is ready",
            `WTS found ${blockCount} ${blockCount === 1 ? "work block" : "work blocks"}.`,
            "wts-time-review",
          ).catch(() => false);
        }
      } catch {
        // The timer retries after a transient ActivityWatch or Jira error.
      } finally {
        if (generation === generationRef.current) runningRef.current = false;
      }
    };

    function runWhenDue() {
      const currentTime = Date.now();
      const current = loadTimeReviewSchedule();
      const scheduled = scheduledTimeReview(current, currentTime);
      if (!scheduled || current.startedAtUnixMs === 0) return;

      const retryAt = lastAttemptAtRef.current + AUTOMATIC_REVIEW_RETRY_MS;
      if (
        scheduled.due &&
        !runningRef.current &&
        currentTime >= retryAt
      ) {
        lastAttemptAtRef.current = currentTime;
        void buildReview(
          scheduled.startedAtUnixMs,
          scheduled.endedAtUnixMs,
        );
        scheduleWake(currentTime + AUTOMATIC_REVIEW_RETRY_MS);
        return;
      }
      scheduleWake(
        scheduled.due
          ? Math.max(currentTime + MINIMUM_TIMER_DELAY_MS, retryAt)
          : scheduled.dueAtUnixMs,
      );
    }

    const handleVisibility = () => {
      if (document.visibilityState === "visible") runWhenDue();
    };
    runWhenDue();
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      generationRef.current += 1;
      runningRef.current = false;
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [client, notify, schedule]);

  return null;
}
