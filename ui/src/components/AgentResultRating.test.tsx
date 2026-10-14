import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it } from "vitest";
import { AgentResultRatingPanel } from "./AgentResultRating";
import { loadAgentLessons, loadAgentResultRating, withAgentLessons } from "../lib/agentLessons";
beforeEach(() => localStorage.clear());
it("saves result feedback and includes an explicit lesson in a future request", () => {
  render(<AgentResultRatingPanel ratingId="conversation/result" sourceLabel="Code review" />);
  fireEvent.click(screen.getByRole("button", { name: "Poor result" }));
  fireEvent.click(screen.getByRole("button", { name: "2 of 5" }));
  fireEvent.change(screen.getByLabelText("What did the agent do wrong?"), { target: { value: "Use the existing helper" } });
  fireEvent.click(screen.getByRole("button", { name: "Save as lesson for later tasks" }));
  expect(loadAgentResultRating("conversation/result")).toMatchObject({ thumb: "down", stars: 2, correction: "Use the existing helper", savedAsLesson: true });
  expect(withAgentLessons("Fix the toolbar", loadAgentLessons())).toContain("Use the existing helper");
});
