import { useEffect, useRef } from "react";

export interface UseVisiblePollingOptions {
  /**
   * Whether polling is enabled. Defaults to true.
   */
  enabled?: boolean;
  /**
   * Whether to fire the callback immediately when the page becomes visible again.
   * Defaults to true.
   */
  refireOnVisible?: boolean;
}

function isDocumentVisible(): boolean {
  if (typeof document === "undefined" || typeof document.visibilityState === "undefined") {
    return true;
  }
  return document.visibilityState === "visible";
}

/**
 * A React hook that runs a callback on an interval ONLY while `document.visibilityState === "visible"`,
 * pauses when hidden, and optionally fires the callback immediately when the page becomes visible again.
 */
export function useVisiblePolling(
  callback: () => void | Promise<void>,
  intervalMs: number | null,
  options?: UseVisiblePollingOptions,
): void {
  const { enabled = true, refireOnVisible = true } = options ?? {};
  const savedCallback = useRef(callback);

  useEffect(() => {
    savedCallback.current = callback;
  }, [callback]);

  useEffect(() => {
    if (!enabled || intervalMs === null || intervalMs <= 0) {
      return;
    }

    let timer: ReturnType<typeof setInterval> | null = null;

    const startTimer = () => {
      if (timer === null) {
        timer = setInterval(() => {
          void savedCallback.current();
        }, intervalMs);
      }
    };

    const stopTimer = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };

    const handleVisibilityChange = () => {
      if (isDocumentVisible()) {
        if (refireOnVisible) {
          void savedCallback.current();
        }
        stopTimer();
        startTimer();
      } else {
        stopTimer();
      }
    };

    if (isDocumentVisible()) {
      startTimer();
    }

    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      document.addEventListener("visibilitychange", handleVisibilityChange);
    }

    return () => {
      stopTimer();
      if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
        document.removeEventListener("visibilitychange", handleVisibilityChange);
      }
    };
  }, [enabled, intervalMs, refireOnVisible]);
}
