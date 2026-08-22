const TIME_REVIEW_SCHEDULE_KEY = "wts.time-review-schedule.v1";
const TIME_REVIEW_SCHEDULE_EVENT = "wts:time-review-schedule-changed";
const TIME_REVIEW_SNAPSHOT_EVENT = "wts:time-review-snapshot-changed";
const HOUR_MS = 60 * 60 * 1_000;
const MAX_CATCH_UP_MS = 48 * HOUR_MS;

export const timeReviewIntervals = [2, 4, 6, 8, 12] as const;

export type TimeReviewIntervalHours = (typeof timeReviewIntervals)[number];

export interface TimeReviewSchedulePreference {
  schemaVersion: 1;
  enabled: boolean;
  intervalHours: TimeReviewIntervalHours;
  startedAtUnixMs: number;
  lastSuccessfulAtUnixMs: number | null;
  notificationsEnabled: boolean;
}

export interface ScheduledTimeReview {
  due: boolean;
  dueAtUnixMs: number;
  startedAtUnixMs: number;
  endedAtUnixMs: number;
}

export const defaultTimeReviewSchedule: TimeReviewSchedulePreference = {
  schemaVersion: 1,
  enabled: true,
  intervalHours: 4,
  startedAtUnixMs: 0,
  lastSuccessfulAtUnixMs: null,
  notificationsEnabled: false,
};

function isInterval(value: unknown): value is TimeReviewIntervalHours {
  return timeReviewIntervals.includes(value as TimeReviewIntervalHours);
}

function localDayStart(nowUnixMs: number) {
  const start = new Date(nowUnixMs);
  start.setHours(0, 0, 0, 0);
  return start.getTime();
}

export function loadTimeReviewSchedule(
  storage: Pick<Storage, "getItem" | "removeItem"> | undefined =
    globalThis.localStorage,
): TimeReviewSchedulePreference {
  if (!storage) return defaultTimeReviewSchedule;
  try {
    const serialized = storage.getItem(TIME_REVIEW_SCHEDULE_KEY);
    if (!serialized) return defaultTimeReviewSchedule;
    const value = JSON.parse(serialized) as Partial<TimeReviewSchedulePreference>;
    const validLastSuccessful =
      value.lastSuccessfulAtUnixMs === null ||
      (typeof value.lastSuccessfulAtUnixMs === "number" &&
        Number.isSafeInteger(value.lastSuccessfulAtUnixMs) &&
        value.lastSuccessfulAtUnixMs >= 0);
    const validStart =
      typeof value.startedAtUnixMs === "number" &&
      Number.isSafeInteger(value.startedAtUnixMs) &&
      value.startedAtUnixMs >= 0;
    if (
      value.schemaVersion !== 1 ||
      typeof value.enabled !== "boolean" ||
      !isInterval(value.intervalHours) ||
      !validStart ||
      !validLastSuccessful ||
      typeof value.notificationsEnabled !== "boolean"
    ) {
      storage.removeItem(TIME_REVIEW_SCHEDULE_KEY);
      return defaultTimeReviewSchedule;
    }
    return value as TimeReviewSchedulePreference;
  } catch {
    try {
      storage.removeItem(TIME_REVIEW_SCHEDULE_KEY);
    } catch {
      // A disabled storage adapter must not block My time.
    }
    return defaultTimeReviewSchedule;
  }
}

export function saveTimeReviewSchedule(
  preference: TimeReviewSchedulePreference,
  storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage,
) {
  if (!storage) return false;
  try {
    storage.setItem(TIME_REVIEW_SCHEDULE_KEY, JSON.stringify(preference));
    globalThis.dispatchEvent?.(new Event(TIME_REVIEW_SCHEDULE_EVENT));
    return true;
  } catch {
    return false;
  }
}

export function subscribeTimeReviewSchedule(listener: () => void) {
  const handleSchedule = () => listener();
  const handleStorage = (event: Event) => {
    if ((event as StorageEvent).key === TIME_REVIEW_SCHEDULE_KEY) listener();
  };
  globalThis.addEventListener?.(TIME_REVIEW_SCHEDULE_EVENT, handleSchedule);
  globalThis.addEventListener?.("storage", handleStorage);
  return () => {
    globalThis.removeEventListener?.(TIME_REVIEW_SCHEDULE_EVENT, handleSchedule);
    globalThis.removeEventListener?.("storage", handleStorage);
  };
}

export function announceTimeReviewSnapshot() {
  globalThis.dispatchEvent?.(new Event(TIME_REVIEW_SNAPSHOT_EVENT));
}

export function subscribeTimeReviewSnapshot(listener: () => void) {
  globalThis.addEventListener?.(TIME_REVIEW_SNAPSHOT_EVENT, listener);
  return () => {
    globalThis.removeEventListener?.(TIME_REVIEW_SNAPSHOT_EVENT, listener);
  };
}

export function scheduledTimeReview(
  preference: TimeReviewSchedulePreference,
  nowUnixMs: number,
): ScheduledTimeReview | null {
  if (!preference.enabled || !Number.isSafeInteger(nowUnixMs) || nowUnixMs < 0) {
    return null;
  }
  const intervalMs = preference.intervalHours * HOUR_MS;
  const anchor =
    preference.lastSuccessfulAtUnixMs ??
    (preference.startedAtUnixMs > 0
      ? preference.startedAtUnixMs
      : localDayStart(nowUnixMs));
  const dueAtUnixMs = anchor + intervalMs;
  const elapsedIntervals = Math.floor((nowUnixMs - anchor) / intervalMs);
  const endedAtUnixMs =
    elapsedIntervals >= 1
      ? anchor + elapsedIntervals * intervalMs
      : dueAtUnixMs;
  return {
    due: nowUnixMs >= dueAtUnixMs,
    dueAtUnixMs,
    startedAtUnixMs: Math.max(anchor, endedAtUnixMs - MAX_CATCH_UP_MS),
    endedAtUnixMs,
  };
}

export function completeScheduledTimeReview(
  preference: TimeReviewSchedulePreference,
  intervalEndedAtUnixMs: number,
): TimeReviewSchedulePreference {
  return {
    ...preference,
    lastSuccessfulAtUnixMs: Math.max(
      preference.lastSuccessfulAtUnixMs ?? 0,
      intervalEndedAtUnixMs,
    ),
  };
}
