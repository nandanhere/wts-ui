"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Camera, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

export interface SnapshotCreateFormProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (label: string, description?: string) => Promise<void>;
  repoCount: number;
}

/* ------------------------------------------------------------------ */
/*  Accessible create-snapshot dialog                                  */
/* ------------------------------------------------------------------ */

export function SnapshotCreateForm({
  isOpen,
  onClose,
  onSubmit,
  repoCount,
}: SnapshotCreateFormProps) {
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const labelInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (isOpen && !el.open) {
      el.showModal();
    } else if (!isOpen && el.open) {
      el.close();
    }
  }, [isOpen]);

  const handleBackdrop = useCallback(
    (e: React.MouseEvent<HTMLDialogElement>) => {
      if (e.target === dialogRef.current && !isSubmitting) onClose();
    },
    [onClose, isSubmitting]
  );

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = label.trim();
      if (!trimmed) {
        setError("Label is required");
        return;
      }
      setIsSubmitting(true);
      setError(null);
      try {
        await onSubmit(trimmed, description.trim() || undefined);
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to create snapshot");
      } finally {
        setIsSubmitting(false);
      }
    },
    [label, description, onSubmit, onClose]
  );

  if (!isOpen) return null;

  return (
    <dialog
      ref={dialogRef}
      onClick={handleBackdrop}
      onClose={onClose}
      className="fixed inset-0 z-50 m-auto max-w-sm w-[calc(100%-2rem)] rounded-xl border backdrop:bg-black/60 backdrop:backdrop-blur-sm"
      style={{
        background: "var(--color-background-elevated)",
        borderColor: "var(--color-border)",
        color: "var(--color-text-primary)",
      }}
      aria-labelledby="create-snapshot-title"
    >
      <form onSubmit={handleSubmit}>
        <div className="p-5">
          <div className="flex items-center gap-2.5 mb-4">
            <div
              className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0"
              style={{
                background: "rgba(96,165,250,0.12)",
              }}
            >
              <Camera size={14} style={{ color: "var(--accent)" }} aria-hidden="true" />
            </div>
            <div>
              <h3
                id="create-snapshot-title"
                className="text-sm font-semibold text-white tracking-tight"
              >
                Create Snapshot
              </h3>
              <p className="text-[10px] mt-0.5" style={{ color: "var(--color-text-secondary)" }}>
                {repoCount} {repoCount === 1 ? "repository" : "repositories"} will be captured
              </p>
            </div>
          </div>

          {/* Label */}
          <div className="mb-3">
            <label
              htmlFor="snapshot-label"
              className="block text-[10px] font-semibold uppercase tracking-[.08em] mb-1.5"
              style={{ color: "var(--color-text-secondary)" }}
            >
              Label <span style={{ color: "var(--danger)" }}>*</span>
            </label>
            <input
              ref={labelInputRef}
              id="snapshot-label"
              type="text"
              value={label}
              onChange={(e) => {
                setLabel(e.target.value);
                setError(null);
              }}
              placeholder="e.g. Pre-migration state"
              disabled={isSubmitting}
              className="w-full h-8 px-2.5 rounded-lg text-[12px] outline-none transition-colors placeholder:text-muted/40"
              style={{
                background: "var(--color-background-surface)",
                border: `1px solid ${error ? "var(--danger)" : "var(--color-border)"}`,
                color: "var(--color-text-primary)",
              }}
              aria-invalid={!!error}
              aria-describedby={error ? "snapshot-label-error" : undefined}
            />
            {error && (
              <p
                id="snapshot-label-error"
                className="text-[10px] mt-1"
                style={{ color: "var(--danger)" }}
                role="alert"
              >
                {error}
              </p>
            )}
          </div>

          {/* Description */}
          <div className="mb-4">
            <label
              htmlFor="snapshot-desc"
              className="block text-[10px] font-semibold uppercase tracking-[.08em] mb-1.5"
              style={{ color: "var(--color-text-secondary)" }}
            >
              Description{" "}
              <span style={{ color: "var(--color-text-secondary)", opacity: 0.5 }}>
                (optional)
              </span>
            </label>
            <textarea
              id="snapshot-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Why this snapshot matters..."
              disabled={isSubmitting}
              rows={2}
              className="w-full px-2.5 py-1.5 rounded-lg text-[12px] outline-none transition-colors resize-none placeholder:text-muted/40"
              style={{
                background: "var(--color-background-surface)",
                border: "1px solid var(--color-border)",
                color: "var(--color-text-primary)",
              }}
            />
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
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
              type="submit"
              disabled={isSubmitting || !label.trim()}
              className={cn(
                "px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-all flex items-center gap-1.5",
                "bg-accent/15 text-accent border border-accent/25 hover:bg-accent/25",
                (isSubmitting || !label.trim()) && "opacity-50 cursor-not-allowed"
              )}
            >
              {isSubmitting ? (
                <>
                  <Loader2 size={12} className="animate-spin" />
                  Creating…
                </>
              ) : (
                "Create Snapshot"
              )}
            </button>
          </div>
        </div>
      </form>
    </dialog>
  );
}
