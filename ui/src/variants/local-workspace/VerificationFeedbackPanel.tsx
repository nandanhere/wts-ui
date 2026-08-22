import { useEffect, useMemo, useRef, useState } from "react";
import type {
  WorkspaceClient,
  WorkspaceEvidence,
  WorkspaceReviewThread,
} from "../../lib/wtsClient";
import styles from "./VerificationFeedbackPanel.module.css";

interface FailedCheck {
  checkId: string;
  label: string;
  detail: string;
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim()
    ? error.message
    : fallback;
}

export function VerificationFeedbackPanel({
  client,
  evidence,
  workspaceId,
  workspaceKey,
  onNotice,
}: {
  client: WorkspaceClient;
  evidence: WorkspaceEvidence;
  workspaceId: string;
  workspaceKey: string;
  onNotice: (message: string, kind?: "info" | "error") => void;
}) {
  const completedAtUnixMs = evidence.verificationResult.completedAtUnixMs;
  const failedChecks = useMemo<FailedCheck[]>(() => {
    const labels = new Map(
      evidence.verificationPlan.checks.map((check) => [check.id, check.label]),
    );
    return evidence.verificationResult.checks
      .filter(
        (check) => check.status === "failed" || check.status === "timedOut",
      )
      .map((check) => ({
        checkId: check.checkId,
        label: labels.get(check.checkId) ?? check.checkId,
        detail: check.detail,
      }));
  }, [evidence]);
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">(
    "idle",
  );
  const [threads, setThreads] = useState<WorkspaceReviewThread[]>([]);
  const [selectedCheckId, setSelectedCheckId] = useState(
    failedChecks[0]?.checkId ?? "",
  );
  const [body, setBody] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const generation = useRef(0);

  const load = async () => {
    const requestGeneration = ++generation.current;
    setState("loading");
    setError("");
    try {
      const result = await client.listWorkspaceReviewThreads(workspaceId);
      if (requestGeneration !== generation.current) return;
      setThreads(
        result.threads.filter(
          (thread) => thread.target.kind === "verificationCheck",
        ),
      );
      setState("ready");
    } catch (cause) {
      if (requestGeneration !== generation.current) return;
      setError(errorMessage(cause, "WTS could not load check feedback."));
      setState("error");
    }
  };

  useEffect(() => {
    generation.current += 1;
    setOpen(false);
    setState("idle");
    setThreads([]);
    setSelectedCheckId(failedChecks[0]?.checkId ?? "");
    setBody("");
    setError("");
    setSaving(false);
    setResolvingId(null);
  }, [completedAtUnixMs, evidence.verificationResult.planRevision, workspaceId]);

  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );

  if (!failedChecks.length || completedAtUnixMs === null) return null;

  const currentThreads = threads.filter(
    (thread) =>
      thread.target.kind === "verificationCheck" &&
      thread.target.planRevision === evidence.verificationResult.planRevision &&
      thread.target.completedAtUnixMs === completedAtUnixMs,
  );

  const addFeedback = async () => {
    const trimmed = body.trim();
    if (!trimmed || !selectedCheckId || saving) return;
    const requestGeneration = generation.current;
    setSaving(true);
    setError("");
    try {
      const thread = await client.createWorkspaceReviewThread(
        workspaceId,
        {
          kind: "verificationCheck",
          planRevision: evidence.verificationResult.planRevision,
          completedAtUnixMs,
          checkId: selectedCheckId,
        },
        trimmed,
        "user",
      );
      if (requestGeneration !== generation.current) return;
      setThreads((current) => [
        thread,
        ...current.filter((item) => item.threadId !== thread.threadId),
      ]);
      setBody("");
      setSaving(false);
      onNotice(`${workspaceKey} · check context sent to the agent inbox`);
    } catch (cause) {
      if (requestGeneration !== generation.current) return;
      setSaving(false);
      setError(errorMessage(cause, "WTS could not save the check context."));
      onNotice(`${workspaceKey} · check context was not saved`, "error");
    }
  };

  const resolveThread = async (thread: WorkspaceReviewThread) => {
    if (resolvingId) return;
    const requestGeneration = generation.current;
    setResolvingId(thread.threadId);
    setError("");
    try {
      const resolved = await client.resolveWorkspaceReviewThread(
        workspaceId,
        thread.threadId,
        thread.revision,
      );
      if (requestGeneration !== generation.current) return;
      setThreads((current) =>
        current.map((item) =>
          item.threadId === resolved.threadId ? resolved : item,
        ),
      );
      setResolvingId(null);
      onNotice(`${workspaceKey} · check feedback resolved`);
    } catch (cause) {
      if (requestGeneration !== generation.current) return;
      setResolvingId(null);
      setError(errorMessage(cause, "WTS could not resolve this feedback."));
      void load();
    }
  };

  return (
    <details
      className={styles.panel}
      data-ui="verification-feedback.panel"
      data-ui-label="Check feedback panel"
      onToggle={(event) => {
        const nextOpen = event.currentTarget.open;
        setOpen(nextOpen);
        if (nextOpen && state === "idle") void load();
      }}
      open={open}
    >
      <summary>
        <span>
          <b>Explain failed checks</b>
          <small>Send expected failures or environment details to the agent.</small>
        </span>
        <span>{currentThreads.filter((thread) => thread.state === "open").length} open</span>
      </summary>
      {open && <div className={styles.content}>
        {state === "loading" ? (
          <p role="status">WTS loads check feedback…</p>
        ) : state === "error" ? (
          <div className={styles.error} role="alert">
            <span>{error}</span>
            <button onClick={() => void load()} type="button">Try again</button>
          </div>
        ) : (
          <>
            <form
              className={styles.form}
              data-ui="verification-feedback.composer"
              data-ui-label="Check feedback composer"
              onSubmit={(event) => {
                event.preventDefault();
                void addFeedback();
              }}
            >
              <label>
                Failed check
                <select
                  onChange={(event) => setSelectedCheckId(event.target.value)}
                  value={selectedCheckId}
                >
                  {failedChecks.map((check) => (
                    <option key={check.checkId} value={check.checkId}>
                      {check.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Context for the agent
                <textarea
                  maxLength={16 * 1024}
                  onChange={(event) => setBody(event.target.value)}
                  placeholder="For example: This check needs the local database service. The code change is not the cause."
                  rows={3}
                  value={body}
                />
              </label>
              <button disabled={!body.trim() || saving} type="submit">
                {saving ? "WTS saves…" : "Send context"}
              </button>
            </form>
            {error && <p className={styles.inlineError} role="alert">{error}</p>}
            <div
              className={styles.threads}
              aria-label="Check feedback"
              data-ui="verification-feedback.threads"
              data-ui-label="Check feedback threads"
            >
              {currentThreads.length === 0 ? (
                <p>No context has been added for this run.</p>
              ) : (
                currentThreads.map((thread) => {
                  const target = thread.target.kind === "verificationCheck"
                    ? thread.target
                    : null;
                  const check = failedChecks.find(
                    (item) => item.checkId === target?.checkId,
                  );
                  return (
                    <article key={thread.threadId} data-state={thread.state}>
                      <header>
                        <b>{check?.label ?? target?.checkId ?? "Check"}</b>
                        <span>{thread.state === "open" ? "Open" : "Resolved"}</span>
                      </header>
                      {thread.comments.map((comment) => (
                        <p key={comment.commentId}>{comment.body}</p>
                      ))}
                      {thread.state === "open" && (
                        <button
                          disabled={resolvingId !== null}
                          onClick={() => void resolveThread(thread)}
                          type="button"
                        >
                          {resolvingId === thread.threadId ? "WTS resolves…" : "Resolve"}
                        </button>
                      )}
                    </article>
                  );
                })
              )}
            </div>
          </>
        )}
      </div>}
    </details>
  );
}
