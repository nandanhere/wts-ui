import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeWorkspaceClient } from "../../test/workspaceClientFake";
import {
  loadActivityWatchReviewHistory,
  loadActivityWatchReviewSnapshot,
} from "./activityWatchReviewCache";
import { TimeReviewScheduler } from "./TimeReviewScheduler";
import {
  loadTimeReviewSchedule,
  saveTimeReviewSchedule,
} from "./timeReviewSchedule";

describe("TimeReviewScheduler", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("persists a due review, advances its watermark, and sends one notification", async () => {
    const now = Date.now();
    const lastSuccessfulAtUnixMs = now - 5 * 60 * 60 * 1_000;
    saveTimeReviewSchedule({
      schemaVersion: 1,
      enabled: true,
      intervalHours: 4,
      startedAtUnixMs: lastSuccessfulAtUnixMs,
      lastSuccessfulAtUnixMs,
      notificationsEnabled: true,
    });
    const fake = fakeWorkspaceClient({
      activityWatchStatus: {
        state: "running",
        installation: "detected",
        endpoint: "http://127.0.0.1:5600",
        apiVersion: "v0",
        serverVersion: "0.13.2",
        capabilities: ["status", "dailyReview"],
        detail: "ActivityWatch is ready.",
      },
      activityWatchDailyReview: {
        schemaVersion: 1,
        startedAtUnixMs: lastSuccessfulAtUnixMs,
        endedAtUnixMs: now,
        totalActiveSeconds: 300,
        sessions: [
          {
            id: "activity-1",
            kind: "coding",
            startedAtUnixMs: lastSuccessfulAtUnixMs,
            endedAtUnixMs: now,
            durationSeconds: 300,
            description: "Updated the review scheduler.",
            sourceEventCount: 2,
          },
        ],
        detail: "One work block was found.",
      },
    });
    fake.getActivityWatchDailyReview.mockImplementation(
      async (startedAtUnixMs, endedAtUnixMs) => ({
        schemaVersion: 1,
        startedAtUnixMs,
        endedAtUnixMs,
        totalActiveSeconds: 300,
        sessions: [
          {
            id: "activity-1",
            kind: "coding",
            startedAtUnixMs,
            endedAtUnixMs,
            durationSeconds: 300,
            description: "Updated the review scheduler.",
            sourceEventCount: 2,
          },
        ],
        detail: "One work block was found.",
      }),
    );
    const notify = vi.fn().mockResolvedValue(true);

    render(<TimeReviewScheduler client={fake.client} notify={notify} />);

    await waitFor(() => {
      expect(fake.getActivityWatchDailyReview).toHaveBeenCalledTimes(1);
    });
    expect(fake.getActivityWatchDailyReview).toHaveBeenCalledWith(
      lastSuccessfulAtUnixMs,
      expect.any(Number),
    );
    expect(fake.listActiveJiraIssues).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(loadActivityWatchReviewSnapshot()).toMatchObject({
        review: { detail: "One work block was found." },
        assignments: {},
      });
      expect(loadTimeReviewSchedule().lastSuccessfulAtUnixMs).toBeGreaterThan(
        lastSuccessfulAtUnixMs,
      );
    });
    const [reviewStart, reviewEnd] =
      fake.getActivityWatchDailyReview.mock.calls[0];
    expect(loadActivityWatchReviewHistory()).toMatchObject([
      {
        startedAtUnixMs: reviewStart,
        endedAtUnixMs: reviewEnd,
        source: "automatic",
        review: { detail: "One work block was found." },
      },
    ]);
    expect(loadTimeReviewSchedule().lastSuccessfulAtUnixMs).toBe(reviewEnd);
    expect(notify).toHaveBeenCalledWith(
      "My time summary is ready",
      "WTS found 1 work block.",
      "wts-time-review",
    );
  });

  it("does not advance the watermark when the interval history cannot persist", async () => {
    const now = Date.now();
    const lastSuccessfulAtUnixMs = now - 5 * 60 * 60 * 1_000;
    saveTimeReviewSchedule({
      schemaVersion: 1,
      enabled: true,
      intervalHours: 4,
      startedAtUnixMs: lastSuccessfulAtUnixMs,
      lastSuccessfulAtUnixMs,
      notificationsEnabled: false,
    });
    const originalSetItem = Storage.prototype.setItem;
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (
        this: Storage,
        key: string,
        value: string,
      ) {
        if (key === "wts.activity-watch-review-history.v1") {
          throw new DOMException("Quota exceeded", "QuotaExceededError");
        }
        return originalSetItem.call(this, key, value);
      });
    const fake = fakeWorkspaceClient({
      activityWatchStatus: {
        state: "running",
        installation: "detected",
        endpoint: "http://127.0.0.1:5600",
        capabilities: ["status", "dailyReview"],
        detail: "ActivityWatch is ready.",
      },
    });
    fake.getActivityWatchDailyReview.mockImplementation(
      async (startedAtUnixMs, endedAtUnixMs) => ({
        schemaVersion: 1,
        startedAtUnixMs,
        endedAtUnixMs,
        totalActiveSeconds: 0,
        sessions: [],
        detail: "No work blocks were found.",
      }),
    );

    render(<TimeReviewScheduler client={fake.client} />);

    await waitFor(() => {
      expect(fake.getActivityWatchDailyReview).toHaveBeenCalledTimes(1);
    });
    expect(loadActivityWatchReviewHistory()).toEqual([]);
    expect(loadTimeReviewSchedule().lastSuccessfulAtUnixMs).toBe(
      lastSuccessfulAtUnixMs,
    );
    setItem.mockRestore();
  });
});
