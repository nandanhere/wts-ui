"use client";

import { useRef, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";
import { TriangleAlert, Copy, Trash2 } from "lucide-react";

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

export interface ConfirmDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmLabel: string;
  variant?: "danger" | "warning";
  isLoading?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Accessible confirmation dialog (uses native <dialog>)              */
/* ------------------------------------------------------------------ */

export function ConfirmDialog({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel,
  variant = "warning",
  isLoading = false,
}: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (isOpen && !el.open) {
      el.showModal();
    } else if (!isOpen && el.open) {
      el.close();
    }
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) {
      confirmRef.current?.focus();
    }
  }, [isOpen]);

  const handleBackdrop = useCallback(
    (e: React.MouseEvent<HTMLDialogElement>) => {
      if (e.target === ref.current) onClose();
    },
    [onClose]
  );

  if (!isOpen) return null;

  const iconColor =
    variant === "danger"
      ? "var(--danger)"
      : "var(--warn)";

  const buttonBg =
    variant === "danger"
      ? "bg-danger/15 text-danger border border-danger/25 hover:bg-danger/25"
      : "bg-warn/15 text-warn border border-warn/25 hover:bg-warn/25";

  return (
    <dialog
      ref={ref}
      onClick={handleBackdrop}
      onClose={onClose}
      className="fixed inset-0 z-50 m-auto max-w-sm w-[calc(100%-2rem)] rounded-xl border backdrop:bg-black/60 backdrop:backdrop-blur-sm"
      style={{
        background: "var(--color-background-elevated)",
        borderColor: "var(--color-border)",
        color: "var(--color-text-primary)",
      }}
      aria-labelledby="confirm-dialog-title"
      aria-describedby="confirm-dialog-message"
    >
      <div className="p-5">
        <div className="flex items-start gap-3 mb-4">
          <div
            className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
            style={{
              background: variant === "danger"
                ? "rgba(248,113,113,0.12)"
                : "rgba(251,191,36,0.12)",
            }}
          >
            {variant === "danger" ? (
              <Trash2 size={15} style={{ color: iconColor }} aria-hidden="true" />
            ) : (
              <TriangleAlert size={15} style={{ color: iconColor }} aria-hidden="true" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <h3
              id="confirm-dialog-title"
              className="text-sm font-semibold text-white tracking-tight"
            >
              {title}
            </h3>
            <p
              id="confirm-dialog-message"
              className="text-xs mt-1.5 leading-relaxed"
              style={{ color: "var(--color-text-secondary)" }}
            >
              {message}
            </p>
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <button
            onClick={onClose}
            disabled={isLoading}
            className="px-3 py-1.5 rounded-lg text-[11px] font-medium transition-all"
            style={{
              background: "var(--color-background-surface)",
              color: "var(--color-text-secondary)",
              border: "1px solid var(--color-border)",
            }}
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            onClick={onConfirm}
            disabled={isLoading}
            className={cn(
              "px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-all flex items-center gap-1.5",
              buttonBg,
              isLoading && "opacity-60 cursor-not-allowed"
            )}
          >
            {isLoading && (
              <span className="w-3 h-3 border-[1.5px] border-current border-t-transparent rounded-full animate-spin" />
            )}
            {confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}
