import { describe, expect, it, vi } from "vitest";
import {
  activityWatchReviewIntervalId,
  loadActivityWatchReviewHistory,
  loadActivityWatchReviewSnapshot,
  localDateKey,
  saveActivityWatchReviewHistorySnapshot,
  saveActivityWatchReviewSnapshot,
  type ActivityWatchReviewIntervalSnapshot,
  type ActivityWatchReviewSnapshot,
} from "./activityWatchReviewCache";

function snapshot(): ActivityWatchReviewSnapshot {
  return {
    schemaVersion: 1,
    dateKey: "2026-07-30",
    builtAtUnixMs: 1_785_400_000_000,
    review: {
      schemaVersion: 1,
      startedAtUnixMs: 1_785_369_600_000,
      endedAtUnixMs: 1_785_400_000_000,
      totalActiveSeconds: 1_800,
      sessions: [
        {
          id: "aw-1",
          kind: "coding",
          startedAtUnixMs: 1_785_390_000_000,
          endedAtUnixMs: 1_785_391_800_000,
          durationSeconds: 1_800,
          description: "Coding work for WTS-42",
          jiraIssueKey: "WTS-42",
          application: "Visual Studio Code",
          activityEvidence: "WTS-42",
          sourceEventCount: 12,
        },
      ],
      detail: "Derived locally.",
    },
    jiraIssues: {
      schemaVersion: 1,
      issues: [
        {
          issueKey: "WTS-42",
          summary: "Persist the time review",
          status: "In Progress",
        },
      ],
      detail: "Assigned active Jira issues.",
    },
    assignments: { "aw-1": "WTS-42" },
  };
}

function intervalSnapshot(
  startedAtUnixMs: number,
  endedAtUnixMs: number,
): ActivityWatchReviewIntervalSnapshot {
  const daily = snapshot();
  return {
    schemaVersion: 1,
    intervalId: activityWatchReviewIntervalId(
      startedAtUnixMs,
      endedAtUnixMs,
    ),
    source: "automatic",
    startedAtUnixMs,
    endedAtUnixMs,
    builtAtUnixMs: endedAtUnixMs + 100,
    review: {
      ...daily.review,
      startedAtUnixMs,
      endedAtUnixMs,
      sessions: daily.review.sessions.map((session) => ({
        ...session,
        id: `session-${startedAtUnixMs}`,
        startedAtUnixMs,
        endedAtUnixMs,
      })),
    },
    jiraIssues: daily.jiraIssues,
  };
}

function mapStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    values,
  };
}

describe("ActivityWatch review cache", () => {
  it("round-trips the bounded review contract under the local date", () => {
    const storage = new Map<string, string>();
    const adapter = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    };

    expect(saveActivityWatchReviewSnapshot(snapshot(), adapter)).toBe(true);
    expect(
      loadActivityWatchReviewSnapshot(adapter, "2026-07-30"),
    ).toEqual(snapshot());
    expect(
      loadActivityWatchReviewSnapshot(adapter, "2026-07-31"),
    ).toBeNull();
  });

  it("removes malformed cached data instead of trusting localStorage", () => {
    const removeItem = vi.fn();
    const adapter = {
      getItem: () =>
        JSON.stringify({
          ...snapshot(),
          review: {
            ...snapshot().review,
            sessions: [
              {
                ...snapshot().review.sessions[0],
                durationSeconds: "thirty minutes",
              },
            ],
          },
        }),
      removeItem,
    };

    expect(
      loadActivityWatchReviewSnapshot(adapter, "2026-07-30"),
    ).toBeNull();
    expect(removeItem).toHaveBeenCalledWith(
      "wts.activity-watch-review.v1:2026-07-30",
    );
  });

  it("uses a stable local calendar date instead of UTC rollover", () => {
    const localDate = new Date(2026, 6, 30, 23, 59);
    expect(localDateKey(localDate)).toBe("2026-07-30");
  });

  it("retains two automatic intervals from the same day after restart", () => {
    const storage = mapStorage();
    const first = intervalSnapshot(1_785_369_600_000, 1_785_376_800_000);
    const second = intervalSnapshot(1_785_376_800_000, 1_785_384_000_000);

    expect(saveActivityWatchReviewHistorySnapshot(first, storage)).toBe(true);
    expect(saveActivityWatchReviewHistorySnapshot(second, storage)).toBe(true);

    const restartedStorage = {
      getItem: storage.getItem,
      removeItem: storage.removeItem,
    };
    expect(loadActivityWatchReviewHistory(restartedStorage)).toEqual([
      second,
      first,
    ]);
    expect(first.endedAtUnixMs).toBe(second.startedAtUnixMs);
    expect(first.intervalId).not.toBe(second.intervalId);
  });

  it("rejects an overlapping interval without changing saved history", () => {
    const storage = mapStorage();
    const first = intervalSnapshot(100, 200);
    expect(saveActivityWatchReviewHistorySnapshot(first, storage)).toBe(true);

    expect(
      saveActivityWatchReviewHistorySnapshot(
        intervalSnapshot(150, 250),
        storage,
      ),
    ).toBe(false);
    expect(loadActivityWatchReviewHistory(storage)).toEqual([first]);
  });

  it("retains only the 32 most recent automatic intervals", () => {
    const storage = mapStorage();
    const hour = 60 * 60 * 1_000;
    for (let index = 0; index < 40; index += 1) {
      expect(
        saveActivityWatchReviewHistorySnapshot(
          intervalSnapshot(index * hour, (index + 1) * hour),
          storage,
        ),
      ).toBe(true);
    }

    const history = loadActivityWatchReviewHistory(storage);
    expect(history).toHaveLength(32);
    expect(history[0].startedAtUnixMs).toBe(39 * hour);
    expect(history.at(-1)?.startedAtUnixMs).toBe(8 * hour);
    expect(
      new TextEncoder().encode(
        storage.values.get("wts.activity-watch-review-history.v1"),
      ).byteLength,
    ).toBeLessThanOrEqual(512 * 1_024);
  });

  it("serializes only sanitized review and Jira summary fields", () => {
    const storage = mapStorage();
    const value = intervalSnapshot(100, 200) as ActivityWatchReviewIntervalSnapshot & {
      rawEvents?: unknown[];
    };
    value.rawEvents = [{ title: "Private browser title" }];
    Object.assign(value.review.sessions[0], {
      rawUrl: "https://private.example/path",
      rawPayload: "private payload",
    });
    Object.assign(value.jiraIssues.issues[0], {
      description: "Private Jira description",
      browserUrl: "https://jira.example/browse/WTS-42",
    });

    expect(saveActivityWatchReviewHistorySnapshot(value, storage)).toBe(true);
    const serialized = storage.values.get(
      "wts.activity-watch-review-history.v1",
    );
    expect(serialized).toBeDefined();
    expect(serialized).not.toContain("Private browser title");
    expect(serialized).not.toContain("private.example");
    expect(serialized).not.toContain("private payload");
    expect(serialized).not.toContain("Private Jira description");
    expect(serialized).not.toContain("jira.example");
    expect(loadActivityWatchReviewHistory(storage)[0]).toEqual(
      intervalSnapshot(100, 200),
    );
  });
});
