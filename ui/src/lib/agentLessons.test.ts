import { beforeEach, describe, expect, it } from "vitest";
import {
  addAgentLesson,
  loadAgentLessons,
  loadAgentResultRating,
  MAX_LESSONS,
  removeAgentLesson,
  saveAgentResultRating,
  withAgentLessons,
} from "./agentLessons";

describe("agent lessons", () => {
  beforeEach(() => localStorage.clear());

  it("keeps a rating for one agent result across reads", () => {
    expect(saveAgentResultRating("c1/m1", { thumb: "down", stars: 2, correction: "Wrong import", savedAsLesson: false, updatedAtUnixMs: 1 })).toBe(true);
    expect(loadAgentResultRating("c1/m1")).toMatchObject({ thumb: "down", stars: 2, correction: "Wrong import" });
    expect(loadAgentResultRating("c1/other")).toBeNull();
  });

  it("rejects a rating outside one to five stars", () => {
    expect(saveAgentResultRating("c1/m1", { thumb: null, stars: 6, correction: "", savedAsLesson: false, updatedAtUnixMs: 1 })).toBe(false);
    expect(loadAgentResultRating("c1/m1")).toBeNull();
  });

  it("saves, deduplicates, caps, and removes lessons", () => {
    addAgentLesson("  Use   the existing helper ", "MR !41", localStorage, 1);
    addAgentLesson("Use the existing helper", "MR !41", localStorage, 2);
    expect(loadAgentLessons().map((lesson) => lesson.text)).toEqual(["Use the existing helper"]);
    for (let index = 0; index < MAX_LESSONS + 3; index += 1) addAgentLesson("Lesson " + index, "UI", localStorage, 10 + index);
    const lessons = loadAgentLessons();
    expect(lessons).toHaveLength(MAX_LESSONS);
    expect(lessons[0]!.text).toBe("Lesson " + (MAX_LESSONS + 2));
    removeAgentLesson(lessons[0]!.id);
    expect(loadAgentLessons().some((lesson) => lesson.id === lessons[0]!.id)).toBe(false);
  });

  it("keeps unique IDs when lessons are added at the same timestamp after the list fills", () => {
    for (let index = 0; index < MAX_LESSONS + 3; index += 1) addAgentLesson("Lesson " + index, "UI", localStorage, 10);
    expect(new Set(loadAgentLessons().map(lesson => lesson.id)).size).toBe(MAX_LESSONS);
  });

  it("adds lessons after the request text and keeps the message limit", () => {
    const lessons = [{ id: "a", text: "Do not add new dependencies", createdAtUnixMs: 1, sourceLabel: "UI" }];
    expect(withAgentLessons("Fix the header", lessons)).toBe(
      "Fix the header\n\nLessons from my earlier feedback. Apply them to this task:\n- Do not add new dependencies",
    );
    expect(withAgentLessons("Fix the header", [])).toBe("Fix the header");
    const long = "x".repeat(16_380);
    expect(withAgentLessons(long, lessons)).toBe(long);
  });
});

