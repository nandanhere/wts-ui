import { memo, useEffect } from "react";
import { Glyph } from "./Glyph";
import styles from "./LocalWorkspace.module.css";

export interface NoticeToast {
  id: string;
  message: string;
  kind: "info" | "error";
}

export interface ToastItemProps {
  toast: NoticeToast;
  onDismiss: (id: string) => void;
}

export const ToastItem = memo(function ToastItem({
  toast,
  onDismiss,
}: ToastItemProps) {
  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(toast.id), 4_000);
    return () => window.clearTimeout(timer);
  }, [toast.id, onDismiss]);

  return (
    <div
      aria-atomic="true"
      aria-label="Workspace command status"
      aria-live={toast.kind === "error" ? "assertive" : "polite"}
      className={`${styles.commandStatus} ${
        toast.kind === "error" ? styles.commandStatusError : ""
      }`}
      role={toast.kind === "error" ? "alert" : "status"}
    >
      <span aria-hidden="true" />
      <span>{toast.message}</span>
      <button
        type="button"
        aria-label="Dismiss notice"
        className={styles.toastDismissButton}
        onClick={() => onDismiss(toast.id)}
      >
        <Glyph name="close" size={12} />
      </button>
    </div>
  );
});

export interface ToastStackProps {
  toasts: NoticeToast[];
  onDismiss: (id: string) => void;
}

export const ToastStack = memo(function ToastStack({
  toasts,
  onDismiss,
}: ToastStackProps) {
  if (toasts.length === 0) return null;

  return (
    <div
      className={styles.toastContainer}
      aria-label="Workspace notices"
      data-ui="notices.stack"
      data-ui-label="Workspace notices"
    >
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
});
