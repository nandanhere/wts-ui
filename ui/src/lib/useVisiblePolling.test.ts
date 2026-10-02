import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVisiblePolling } from "./useVisiblePolling";

describe("useVisiblePolling", () => {
  let originalVisibilityState: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    originalVisibilityState = Object.getOwnPropertyDescriptor(
      document,
      "visibilityState",
    );
  });

  afterEach(() => {
    if (originalVisibilityState) {
      Object.defineProperty(document, "visibilityState", originalVisibilityState);
    } else {
      Reflect.deleteProperty(document, "visibilityState");
    }
    vi.useRealTimers();
  });

  it("calls callback on the interval when document is visible", () => {
    const callback = vi.fn();
    renderHook(() => useVisiblePolling(callback, 1000));

    expect(callback).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(callback).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(callback).toHaveBeenCalledTimes(3);
  });

  it("pauses polling while document is hidden and resumes when visible (refireOnVisible default = true)", () => {
    const callback = vi.fn();
    renderHook(() => useVisiblePolling(callback, 1000));

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(callback).toHaveBeenCalledTimes(2);

    // Hide document
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    // Advance time while hidden
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    // No calls should occur while hidden
    expect(callback).toHaveBeenCalledTimes(2);

    // Make document visible again
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    // Immediate refire on visible (refireOnVisible defaults to true)
    expect(callback).toHaveBeenCalledTimes(3);

    // Further interval ticks resume
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(callback).toHaveBeenCalledTimes(4);
  });

  it("resumes without immediate refire when refireOnVisible is false", () => {
    const callback = vi.fn();
    renderHook(() =>
      useVisiblePolling(callback, 1000, { refireOnVisible: false }),
    );

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(callback).toHaveBeenCalledTimes(1);

    // Hide document
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(callback).toHaveBeenCalledTimes(1);

    // Make document visible again
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    // Should NOT refire immediately
    expect(callback).toHaveBeenCalledTimes(1);

    // Fires after interval passes
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it("does not poll when disabled or intervalMs is null/non-positive", () => {
    const callback = vi.fn();
    const { rerender } = renderHook(
      ({ enabled, interval }) =>
        useVisiblePolling(callback, interval, { enabled }),
      { initialProps: { enabled: false, interval: 1000 as number | null } },
    );

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(callback).not.toHaveBeenCalled();

    rerender({ enabled: true, interval: null });
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(callback).not.toHaveBeenCalled();

    rerender({ enabled: true, interval: 1000 });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("stops polling on unmount", () => {
    const callback = vi.fn();
    const { unmount } = renderHook(() => useVisiblePolling(callback, 1000));

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(callback).toHaveBeenCalledTimes(1);

    unmount();

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
