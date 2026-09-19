import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import styles from "./UiCallouts.module.css";
import { captureUiRegion, isRegionEditable, isRegionExcluded, UI_REGION_SELECTED_EVENT, type UiRegionSelection } from "./uiRegionSelection";

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
  if (!id || !label || isRegionExcluded(element)) return null;
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
    if (hit.closest('[data-ui-context="exclude"]')) return null;
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
    !event.altKey &&
    event.shiftKey &&
    event.code === "KeyL"
  );
}

export function UiCallouts({ onRegionSelected }: { onRegionSelected?: (selection: UiRegionSelection) => void } = {}) {
  const [enabled, setEnabled] = useState(false);
  const [picking, setPicking] = useState(false);
  const pickingRef = useRef(false);
  const blockUntilAltUp = useRef(false);
  const interceptedPress = useRef(false);
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

  const stopPicker = useCallback(() => {
    pickingRef.current = false;
    setPicking(false);
    document.documentElement.removeAttribute("data-ui-region-picker");
    clearCallout();
  }, [clearCallout]);

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
      if (pickingRef.current) clearCallout();
      else scheduleClear();
      return;
    }
    const next = calloutAtPoint(pointer.x, pointer.y);
    if (!next) {
      if (pickingRef.current) clearCallout();
      else scheduleClear();
      return;
    }
    cancelScheduledClear();
    activeElementRef.current = next.element;
    setCallout(next);
  }, [cancelScheduledClear, clearCallout, scheduleClear]);

  const selectCallout = useCallback((next: Callout) => {
    const selection = captureUiRegion(next.element);
    if (!selection) return;
    blockUntilAltUp.current = true;
    // Remove the picker before listeners capture pixels or open a chat panel.
    flushSync(() => { stopPicker(); setEnabled(false); });
    window.dispatchEvent(new CustomEvent(UI_REGION_SELECTED_EVENT, { detail: selection }));
    onRegionSelected?.(selection);
  }, [onRegionSelected, stopPicker]);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.repeat) return;
      if (event.getModifierState("AltGraph") || event.key === "AltGraph") {
        blockUntilAltUp.current = true;
        stopPicker();
        return;
      }
      if (event.key === "Enter" && event.altKey && !event.ctrlKey && !event.metaKey && !blockUntilAltUp.current) {
        const target = event.composedPath()[0] ?? event.target;
        if (isRegionEditable(target) || isRegionEditable(document.activeElement) || (target instanceof Element && isRegionExcluded(target))) return;
        const focused = document.activeElement?.closest<HTMLElement>(calloutSelector);
        const next = focused ? calloutForElement(focused) : activeElementRef.current ? calloutForElement(activeElementRef.current) : null;
        if (!next) return;
        event.preventDefault(); event.stopImmediatePropagation();
        selectCallout(next);
        return;
      }
      if (event.key === "Alt" && !event.ctrlKey && !event.metaKey) {
        if (isRegionEditable(event.composedPath()[0] ?? event.target) || isRegionEditable(document.activeElement)) {
          blockUntilAltUp.current = true;
          stopPicker();
          return;
        }
        blockUntilAltUp.current = false;
        event.preventDefault();
        event.stopPropagation();
        pickingRef.current = true;
        setPicking(true);
        document.documentElement.setAttribute("data-ui-region-picker", "");
        refreshCallout();
        return;
      }
      if (isCalloutToggle(event)) {
        event.preventDefault();
        event.stopPropagation();
        if (enabled) clearCallout();
        setEnabled(!enabled);
        return;
      }
      if ((enabled || pickingRef.current) && event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        blockUntilAltUp.current = true;
        stopPicker();
        setEnabled(false);
      }
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Alt" || event.key === "AltGraph") {
        blockUntilAltUp.current = false;
        stopPicker();
      }
    };
    const handleBlur = () => {
      blockUntilAltUp.current = true;
      interceptedPress.current = false;
      stopPicker();
    };
    const handleFocus = (event: FocusEvent) => {
      if (isRegionEditable(event.composedPath()[0] ?? event.target)) {
        blockUntilAltUp.current = true;
        stopPicker();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
    window.addEventListener("blur", handleBlur);
    document.addEventListener("focusin", handleFocus, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
      window.removeEventListener("blur", handleBlur);
      document.removeEventListener("focusin", handleFocus, true);
    };
  }, [clearCallout, enabled, refreshCallout, selectCallout, stopPicker]);

  useEffect(() => {
    const eligible = (event: MouseEvent) => {
      const target = event.composedPath()[0] ?? event.target;
      return event.button === 0 && event.altKey && !event.ctrlKey && !event.metaKey &&
        !event.getModifierState("AltGraph") && !blockUntilAltUp.current &&
        !isRegionEditable(target) && target instanceof Element && !isRegionExcluded(target);
    };
    const swallow = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation(); };
    const handlePress = (event: MouseEvent) => {
      interceptedPress.current = false;
      if (eligible(event) && calloutAtPoint(event.clientX, event.clientY)) {
        interceptedPress.current = true;
        swallow(event);
      }
    };
    const handleCancel = () => {
      interceptedPress.current = false;
      blockUntilAltUp.current = true;
      stopPicker();
    };
    const handleRelease = (event: MouseEvent) => {
      if (interceptedPress.current) swallow(event);
    };
    const handleClick = (event: MouseEvent) => {
      const canSelect = eligible(event);
      const next = canSelect ? calloutAtPoint(event.clientX, event.clientY) : null;
      if (!interceptedPress.current && !next) return;
      interceptedPress.current = false;
      swallow(event);
      if (!next) return;
      selectCallout(next);
    };
    window.addEventListener("pointerdown", handlePress, true);
    window.addEventListener("mousedown", handlePress, true);
    window.addEventListener("pointerup", handleRelease, true);
    window.addEventListener("pointercancel", handleCancel, true);
    window.addEventListener("mouseup", handleRelease, true);
    window.addEventListener("click", handleClick, true);
    return () => {
      window.removeEventListener("pointerdown", handlePress, true);
      window.removeEventListener("mousedown", handlePress, true);
      window.removeEventListener("pointerup", handleRelease, true);
      window.removeEventListener("pointercancel", handleCancel, true);
      window.removeEventListener("mouseup", handleRelease, true);
      window.removeEventListener("click", handleClick, true);
    };
  }, [selectCallout, stopPicker]);

  useEffect(() => {
    document.documentElement.toggleAttribute("data-ui-debug", enabled);

    let frame = 0;
    const handlePointerMove = (event: PointerEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest(calloutOverlaySelector)
      ) {
        return;
      }
      pointerRef.current = { x: event.clientX, y: event.clientY };
      if (!enabled && !pickingRef.current) return;
      if (pickingRef.current && event.target instanceof Element && (isRegionEditable(event.target) || isRegionExcluded(event.target))) {
        clearCallout();
        return;
      }
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(refreshCallout);
    };
    const handlePointerLeave = () => {
      pointerRef.current = null;
      if (pickingRef.current) clearCallout();
      else scheduleClear();
    };
    const scheduleRefresh = () => {
      if (!enabled && !pickingRef.current) return;
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
    picking,
    refreshCallout,
    scheduleClear,
  ]);

  useEffect(
    () => () => {
      cancelScheduledClear();
      document.documentElement.removeAttribute("data-ui-debug");
      document.documentElement.removeAttribute("data-ui-region-picker");
    },
    [cancelScheduledClear],
  );

  if (!enabled && !picking) return null;

  const shortcut = navigator.userAgent.includes("Mac") ? "⌘⇧L" : "Ctrl+Shift+L";
  const rect = callout?.rect;
  const labelLeft = rect
    ? Math.max(4, Math.min(rect.left, window.innerWidth - 328))
    : 0;
  const labelTop = rect
    ? Math.max(4, Math.min(rect.top, window.innerHeight - 48))
    : 0;

  return createPortal(
    <div
      className={`${styles.overlay} ${picking ? styles.picker : ""}`}
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
            <span>{callout.label}</span>
            <code>{callout.id}</code>
          </div>
        </>
      )}
      <div className={styles.control}>
        <span>{picking ? "Click a region to discuss it. Release Option to cancel." : "Hover over a region. Say its name or ID to Codex."}</span>
        <kbd>{picking ? "Option / Alt" : shortcut}</kbd>
        <button
          className={styles.exit}
          onClick={() => {
            blockUntilAltUp.current = true;
            stopPicker();
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
