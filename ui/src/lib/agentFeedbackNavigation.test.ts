import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { highlightFeedbackSelection } from "./agentFeedbackNavigation";

describe("return to a feedback selection", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); vi.restoreAllMocks(); });

  function region(id: string, tag = "section") {
    const element = document.createElement(tag);
    element.dataset.ui = id;
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue({ width: 200, height: 80 } as DOMRect);
    element.scrollIntoView = vi.fn();
    document.body.append(element);
    return element;
  }

  it("scrolls to the visible region, gives it focus, and removes the temporary decoration", () => {
    const hidden = region("workspace.target"); hidden.setAttribute("hidden", "");
    const excluded = region("workspace.target"); excluded.dataset.uiContext = "exclude";
    const target = region("workspace.target");
    const missing = vi.fn();
    highlightFeedbackSelection("workspace.target", () => true, missing);
    vi.advanceTimersByTime(20);
    expect(target.scrollIntoView).toHaveBeenCalledWith({ block: "center", inline: "nearest", behavior: "instant" });
    expect(document.activeElement).toBe(target);
    expect(target.dataset.feedbackReveal).toBe("true");
    expect(hidden.scrollIntoView).not.toHaveBeenCalled();
    expect(excluded.scrollIntoView).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2_000);
    expect(target.hasAttribute("data-feedback-reveal")).toBe(false);
    expect(target.hasAttribute("tabindex")).toBe(false);
    expect(missing).not.toHaveBeenCalled();
  });

  it("preserves a control's tab order and never activates it", () => {
    const target = region("workspace.action", "button"); target.tabIndex = 2;
    const click = vi.fn(); target.addEventListener("click", click);
    const cancel = highlightFeedbackSelection("workspace.action", () => true, vi.fn());
    vi.advanceTimersByTime(20);
    expect(document.activeElement).toBe(target);
    expect(click).not.toHaveBeenCalled();
    cancel();
    expect(target.tabIndex).toBe(2);
    expect(target.dataset.feedbackReveal).toBeUndefined();
  });

  it("waits for the selected region to mount", () => {
    const missing = vi.fn();
    const cancel = highlightFeedbackSelection("workspace.delayed", () => true, missing);
    vi.advanceTimersByTime(200);
    const target = region("workspace.delayed");
    vi.advanceTimersByTime(20);
    expect(document.activeElement).toBe(target);
    expect(missing).not.toHaveBeenCalled();
    cancel();
  });

  it("does not take focus or show a missing-region notice after newer navigation", () => {
    let current = true;
    const missing = vi.fn();
    highlightFeedbackSelection("workspace.delayed", () => current, missing);
    vi.advanceTimersByTime(200);
    current = false;
    const target = region("workspace.delayed");
    vi.advanceTimersByTime(3_000);
    expect(target.scrollIntoView).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(target);
    expect(missing).not.toHaveBeenCalled();
  });

  it("gives a single recovery notice when the saved region no longer exists", () => {
    const missing = vi.fn();
    highlightFeedbackSelection("workspace.removed", () => true, missing);
    vi.advanceTimersByTime(6_000);
    expect(missing).toHaveBeenCalledOnce();
  });
});
