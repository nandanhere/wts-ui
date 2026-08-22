import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import styles from "./UiCallouts.module.css";

type Callout = {
  element: HTMLElement;
  id: string;
  label: string;
  rect: DOMRect;
};

const calloutSelector = "[data-ui]";
const calloutOverlaySelector = "[data-ui-callout-overlay]";
const calloutLingerMs = 1_200;

function calloutForElement(element: HTMLElement): Callout | null {
  const id = element?.dataset.ui?.trim();
  const label = element?.dataset.uiLabel?.trim();
  if (!id || !label) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return { element, id, label, rect };
}

function calloutAtPoint(clientX: number, clientY: number): Callout | null {
  const hitTest = document.elementsFromPoint?.(clientX, clientY) ?? [];
  for (const hit of hitTest) {
    if (!(hit instanceof HTMLElement) || hit.closest(calloutOverlaySelector)) {
      continue;
    }
    const annotated = hit.closest<HTMLElement>(calloutSelector);
    if (!annotated) continue;
    const callout = calloutForElement(annotated);
    if (
      callout &&
      clientX >= callout.rect.left &&
      clientX <= callout.rect.right &&
      clientY >= callout.rect.top &&
      clientY <= callout.rect.bottom
    ) {
      return callout;
    }
  }

  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>(calloutSelector),
  ).flatMap((element) => {
    const callout = calloutForElement(element);
    if (
      !callout ||
      clientX < callout.rect.left ||
      clientX > callout.rect.right ||
      clientY < callout.rect.top ||
      clientY > callout.rect.bottom
    ) {
      return [];
    }
    return [callout];
  });

  candidates.sort((left, right) => {
    if (left.element.contains(right.element)) return 1;
    if (right.element.contains(left.element)) return -1;
    return (
      left.rect.width * left.rect.height -
      right.rect.width * right.rect.height
    );
  });
  return candidates[0] ?? null;
}

function isCalloutToggle(event: globalThis.KeyboardEvent) {
  return (
    (event.metaKey || event.ctrlKey) &&
    event.shiftKey &&
    event.code === "KeyL"
  );
}

export function UiCallouts() {
  const [enabled, setEnabled] = useState(false);
  const [callout, setCallout] = useState<Callout | null>(null);
  const activeElementRef = useRef<HTMLElement | null>(null);
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointerRef = useRef<{ x: number; y: number } | null>(null);

  const cancelScheduledClear = useCallback(() => {
    if (clearTimerRef.current === null) return;
    clearTimeout(clearTimerRef.current);
    clearTimerRef.current = null;
  }, []);

  const clearCallout = useCallback(() => {
    cancelScheduledClear();
    activeElementRef.current = null;
    setCallout(null);
  }, [cancelScheduledClear]);

  const scheduleClear = useCallback(() => {
    if (clearTimerRef.current !== null) return;
    clearTimerRef.current = setTimeout(() => {
      activeElementRef.current = null;
      clearTimerRef.current = null;
      setCallout(null);
    }, calloutLingerMs);
  }, []);

  const refreshCallout = useCallback(() => {
    const pointer = pointerRef.current;
    if (!pointer) {
      scheduleClear();
      return;
    }
    const next = calloutAtPoint(pointer.x, pointer.y);
    if (!next) {
      scheduleClear();
      return;
    }
    cancelScheduledClear();
    activeElementRef.current = next.element;
    setCallout(next);
  }, [cancelScheduledClear, scheduleClear]);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.repeat) return;
      if (isCalloutToggle(event)) {
        event.preventDefault();
        event.stopPropagation();
        if (enabled) clearCallout();
        setEnabled(!enabled);
        return;
      }
      if (enabled && event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        clearCallout();
        setEnabled(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [clearCallout, enabled]);

  useEffect(() => {
    document.documentElement.toggleAttribute("data-ui-debug", enabled);
    if (!enabled) return;

    let frame = 0;
    const handlePointerMove = (event: PointerEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest(calloutOverlaySelector)
      ) {
        return;
      }
      pointerRef.current = { x: event.clientX, y: event.clientY };
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(refreshCallout);
    };
    const handlePointerLeave = () => {
      pointerRef.current = null;
      scheduleClear();
    };
    const scheduleRefresh = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(refreshCallout);
    };

    document.addEventListener("pointermove", handlePointerMove, true);
    document.documentElement.addEventListener(
      "pointerleave",
      handlePointerLeave,
      true,
    );
    window.addEventListener("resize", scheduleRefresh);
    window.addEventListener("scroll", scheduleRefresh, true);

    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("pointermove", handlePointerMove, true);
      document.documentElement.removeEventListener(
        "pointerleave",
        handlePointerLeave,
        true,
      );
      window.removeEventListener("resize", scheduleRefresh);
      window.removeEventListener("scroll", scheduleRefresh, true);
    };
  }, [
    cancelScheduledClear,
    clearCallout,
    enabled,
    refreshCallout,
    scheduleClear,
  ]);

  useEffect(
    () => () => {
      cancelScheduledClear();
      document.documentElement.removeAttribute("data-ui-debug");
    },
    [cancelScheduledClear],
  );

  if (!enabled) return null;

  const shortcut = navigator.userAgent.includes("Mac") ? "⌘⇧L" : "Ctrl+Shift+L";
  const rect = callout?.rect;
  const labelLeft = rect
    ? Math.max(4, Math.min(rect.left, window.innerWidth - 220))
    : 0;
  const labelTop = rect
    ? Math.max(4, Math.min(rect.top, window.innerHeight - 28))
    : 0;

  return createPortal(
    <div
      className={styles.overlay}
      data-testid="ui-callouts-overlay"
      data-ui-callout-overlay
    >
      {callout && rect && (
        <>
          <div
            aria-hidden="true"
            className={styles.outline}
            style={{
              height: rect.height,
              left: rect.left,
              top: rect.top,
              width: rect.width,
            }}
          />
          <div
            className={styles.label}
            role="status"
            style={{ left: labelLeft, top: labelTop }}
          >
            {callout.label}
          </div>
        </>
      )}
      <div className={styles.control}>
        <span>Hover over a UI region. Say its label to Codex.</span>
        <kbd>{shortcut}</kbd>
        <button
          className={styles.exit}
          onClick={() => {
            clearCallout();
            setEnabled(false);
          }}
          type="button"
        >
          Exit
        </button>
      </div>
    </div>,
    document.body,
  );
}
