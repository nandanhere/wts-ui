import { describe, expect, it } from "vitest";
import {
  completeScheduledTimeReview,
  defaultTimeReviewSchedule,
  loadTimeReviewSchedule,
  saveTimeReviewSchedule,
  scheduledTimeReview,
} from "./timeReviewSchedule";

function memoryStorage(initial?: string) {
  let value = initial ?? null;
  return {
    getItem: () => value,
    removeItem: () => {
      value = null;
    },
    setItem: (_key: string, next: string) => {
      value = next;
    },
    value: () => value,
  };
}

describe("time review schedule", () => {
  it("defaults to a four-hour schedule", () => {
    const storage = memoryStorage();
    expect(loadTimeReviewSchedule(storage)).toEqual(defaultTimeReviewSchedule);
  });

  it("becomes due from the last successful watermark", () => {
    const preference = {
      ...defaultTimeReviewSchedule,
      lastSuccessfulAtUnixMs: 10_000,
    };
    expect(scheduledTimeReview(preference, 10_000 + 4 * 60 * 60 * 1_000 - 1)?.due)
      .toBe(false);
    expect(scheduledTimeReview(preference, 10_000 + 4 * 60 * 60 * 1_000)?.due)
      .toBe(true);
  });

  it("bounds restart catch-up to 48 hours", () => {
    const now = 10 * 24 * 60 * 60 * 1_000;
    const result = scheduledTimeReview(
      { ...defaultTimeReviewSchedule, lastSuccessfulAtUnixMs: 1 },
      now,
    );
    expect(
      (result?.endedAtUnixMs ?? 0) - (result?.startedAtUnixMs ?? 0),
    ).toBe(48 * 60 * 60 * 1_000);
    expect(result?.endedAtUnixMs).toBeLessThanOrEqual(now);
    expect(now - (result?.endedAtUnixMs ?? 0)).toBeLessThan(
      defaultTimeReviewSchedule.intervalHours * 60 * 60 * 1_000,
    );
  });

  it("advances the watermark only after completion", () => {
    expect(
      completeScheduledTimeReview(defaultTimeReviewSchedule, 42)
        .lastSuccessfulAtUnixMs,
    ).toBe(42);
  });

  it("uses the preceding interval end as the next interval start", () => {
    const firstEnd = 8 * 60 * 60 * 1_000;
    const completed = completeScheduledTimeReview(
      defaultTimeReviewSchedule,
      firstEnd,
    );
    const next = scheduledTimeReview(
      completed,
      firstEnd + 4 * 60 * 60 * 1_000,
    );

    expect(next).toMatchObject({
      due: true,
      startedAtUnixMs: firstEnd,
      endedAtUnixMs: firstEnd + 4 * 60 * 60 * 1_000,
    });
  });

  it("does not move the successful watermark backward", () => {
    expect(
      completeScheduledTimeReview(
        { ...defaultTimeReviewSchedule, lastSuccessfulAtUnixMs: 100 },
        90,
      ).lastSuccessfulAtUnixMs,
    ).toBe(100);
  });

  it("rejects an invalid saved interval", () => {
    const storage = memoryStorage(
      JSON.stringify({
        ...defaultTimeReviewSchedule,
        intervalHours: 1,
      }),
    );
    expect(loadTimeReviewSchedule(storage)).toEqual(defaultTimeReviewSchedule);
    expect(storage.value()).toBeNull();
  });

  it("round-trips a valid preference", () => {
    const storage = memoryStorage();
    const preference = {
      ...defaultTimeReviewSchedule,
      enabled: false,
      notificationsEnabled: true,
      lastSuccessfulAtUnixMs: 123,
    };
    expect(saveTimeReviewSchedule(preference, storage)).toBe(true);
    expect(loadTimeReviewSchedule(storage)).toEqual(preference);
  });
});
