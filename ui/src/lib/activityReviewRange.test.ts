import { describe, expect, it, vi } from "vitest";
import { loadActivityReviewRange } from "./activityReviewRange";
const DAY = 86_400_000;
function client() {
  return { getActivityWatchDailyReview: vi.fn(async (start: number, end: number) => ({
    schemaVersion: 1 as const, startedAtUnixMs: start, endedAtUnixMs: end,
    totalActiveSeconds: 60, detail: "Ready", sessions: [],
  })) };
}
describe("activity summaries", () => {
  it("reads all seven days in bounded requests without gaps or duplicate totals", async () => {
    const source = client();
    const result = await loadActivityReviewRange(source, DAY, DAY * 8);
    expect(source.getActivityWatchDailyReview.mock.calls).toEqual(Array.from({ length: 7 }, (_, index) => [DAY * (index + 1), DAY * (index + 2)]));
    expect(result.totalActiveSeconds).toBe(420);
    expect(result.startedAtUnixMs).toBe(DAY);
    expect(result.endedAtUnixMs).toBe(8 * DAY);
  });
  it("does not label an incomplete week as a complete summary", async () => {
    const source = client();
    source.getActivityWatchDailyReview.mockRejectedValueOnce(new Error("Offline"));
    await expect(loadActivityReviewRange(source, 0, 7 * DAY)).rejects.toThrow("Offline");
    expect(source.getActivityWatchDailyReview).toHaveBeenCalledTimes(1);
  });
  it("rejects mismatched response windows", async () => {
    const source = client();
    source.getActivityWatchDailyReview.mockResolvedValueOnce({ schemaVersion: 1, startedAtUnixMs: 0, endedAtUnixMs: 1, totalActiveSeconds: 60, detail: "Ready", sessions: [] });
    await expect(loadActivityReviewRange(source, 0, 7 * DAY)).rejects.toThrow("does not match");
  });
});
