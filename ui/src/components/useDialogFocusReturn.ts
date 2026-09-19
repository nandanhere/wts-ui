import { useRef } from "react";

/** Return focus for controlled dialogs that have no Radix Trigger. */
export function useDialogFocusReturn(initialFocusSelector?: string) {
  const target = useRef<HTMLElement | null>(null);
  return {
    onOpenAutoFocus(event: Event) {
      const active = document.activeElement;
      if (active instanceof HTMLElement && !active.closest('[role="dialog"]')) {
        target.current = active;
      }
      const initial = initialFocusSelector && event.target instanceof HTMLElement
        ? event.target.querySelector<HTMLElement>(initialFocusSelector)
        : null;
      if (initial) {
        event.preventDefault();
        initial.focus({ preventScroll: true });
      }
    },
    onCloseAutoFocus(event: Event) {
      const element = target.current;
      if (!element?.isConnected || element === document.body) return;
      event.preventDefault();
      if (!document.querySelector('[role="dialog"][data-state="open"]')) {
        element.focus({ preventScroll: true });
      }
    },
  };
}
