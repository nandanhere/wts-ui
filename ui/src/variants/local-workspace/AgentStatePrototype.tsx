import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useVisiblePolling } from "../../lib/useVisiblePolling";
import type {
  AgentProvider,
  AgentSession,
  AgentSessionDetail,
  ObservedAgentSession,
  WorkspaceClient,
} from "../../lib/wtsClient";
import styles from "./AgentStatePrototype.module.css";

const POLL_INTERVAL_MS = 5_000;

const providerLabels: Record<AgentProvider, string> = {
  codex: "Codex",
  openCode: "OpenCode",
  hermes: "Hermes",
};

function heartbeatLabel(unixMs: number) {
  return new Date(unixMs).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function sessionStatusLabel(session: AgentSession) {
  const provider = providerLabels[session.provider];
  if (session.needsInput?.kind === "question") {
    return `${provider} has a question`;
  }
  if (session.needsInput?.kind === "access") {
    return `${provider} needs access`;
  }
  const labels: Record<AgentSession["status"], string> = {
    launching: `WTS starts ${provider} in the background`,
    handoffAccepted: `${provider} opened in Terminal`,
    running: `${provider} is working in the background`,
    stopping: `WTS stops the background ${provider} task`,
    completed: `${provider} completed the background task`,
    failed: `${provider} failed the background task`,
    interrupted: `${provider} stopped the background task`,
  };
  return labels[session.status];
}

function sessionDetail(session: AgentSession) {
  if (session.needsInput) return session.needsInput.detail;
  if (session.failure === "userStopped") return "Stopped by you";
  if (session.failure === "processExited") return "Connection lost after WTS restarted";
  if (session.failure === "staleHeartbeat") return "Process stopped reporting state";
  if (session.failure === "providerFailed") return "Provider exited with an error";
  if (session.failure === "launchRejected") return "Provider could not be started";
  if (session.failure === "launchOutcomeUnknown") return "Launch outcome could not be observed";
  if (session.status === "handoffAccepted") {
    return "External Terminal accepted the handoff. WTS cannot observe that process.";
  }
  return `Updated ${heartbeatLabel(session.lastHeartbeatAtUnixMs)}`;
}

function isManagedActive(session: AgentSession | null) {
  return (
    session?.status === "launching" ||
    session?.status === "running" ||
    session?.status === "stopping"
  );
}

function observationStatusLabel(session: ObservedAgentSession) {
  const provider = session.provider === "copilot" ? "Copilot" : "Codex";
  if (session.needsInput?.kind === "question") {
    return `${provider} has a question`;
  }
  if (session.needsInput?.kind === "access") {
    return `${provider} needs access`;
  }
  if (session.status === "working") return `${provider} is working`;
  if (session.status === "idle") return `${provider} is open in VS Code`;
  if (session.status === "interrupted") return `${provider} was interrupted`;
  return `${provider} activity is stale`;
}

function observationActivityLabel(
  activity: ObservedAgentSession["activity"],
) {
  if (activity === "thinking") return "Preparing an update";
  if (activity === "usingTools") return "Using tools";
  if (activity === "editing") return "Editing files";
  if (activity === "runningCommand") return "Running a command";
  if (activity === "searching") return "Searching";
  if (activity === "delegating") return "Coordinating another agent";
  return "No recent activity detail";
}

export function AgentStatePrototype({
  client,
  workspaceId,
  materialized,
  provider = "codex",
}: {
  client: WorkspaceClient;
  workspaceId: string;
  materialized: boolean;
  provider?: AgentProvider;
}) {
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [observedSessions, setObservedSessions] = useState<
    ObservedAgentSession[]
  >([]);
  const [sessionDetails, setSessionDetails] = useState<
    Record<string, AgentSessionDetail>
  >({});
  const [prompt, setPrompt] = useState(
    "Read WTS.md, work on the workspace goal, and report the result.",
  );
  const [submittedTask, setSubmittedTask] = useState<string | null>(null);
  const [busy, setBusy] = useState<"idle" | "loading" | "starting" | "stopping">(
    "loading",
  );
  const [error, setError] = useState("");
  const taskFieldId = useId();
  const taskDisclosureId = useId();
  const generationRef = useRef(0);

  const refresh = useCallback(async (showLoading = false) => {
    const generation = generationRef.current;
    if (showLoading) setBusy("loading");
    try {
      const result = await client.listAgentSessions(workspaceId);
      if (generation !== generationRef.current) return;
      setSessions(result.sessions);
      setObservedSessions(result.observedSessions ?? []);
      const detailResults = await Promise.allSettled(
        result.sessions.map((item) => client.getAgentSessionDetail(item.sessionId)),
      );
      if (generation !== generationRef.current) return;
      setSessionDetails(
        Object.fromEntries(
          detailResults.flatMap((detail) =>
            detail.status === "fulfilled"
              ? [[detail.value.sessionId, detail.value] as const]
              : [],
          ),
        ),
      );
      setError("");
    } catch (cause) {
      if (generation !== generationRef.current) return;
      setError(
        cause instanceof Error
          ? cause.message
          : "WTS could not read the agent connection.",
      );
    } finally {
      if (generation === generationRef.current) setBusy("idle");
    }
  }, [client, workspaceId]);

  useEffect(() => {
    generationRef.current += 1;
    void refresh(true);
    return () => {
      generationRef.current += 1;
    };
  }, [refresh]);

  const isPollingEnabled =
    materialized && (sessions.length > 0 || observedSessions.length > 0);

  const handlePoll = useCallback(() => {
    void refresh(false);
  }, [refresh]);

  useVisiblePolling(handlePoll, POLL_INTERVAL_MS, {
    enabled: isPollingEnabled,
  });

  const start = async () => {
    if (!materialized || busy !== "idle" || !prompt.trim()) return;
    const task = prompt.trim();
    const generation = generationRef.current;
    setBusy("starting");
    setError("");
    try {
      const next = await client.launchAgentSession(workspaceId, {
        provider,
        prompt: task,
        category: "implementation",
      });
      if (generation !== generationRef.current) return;
      setSubmittedTask(task);
      setSessions((current) => [
        next,
        ...current.filter((item) => item.sessionId !== next.sessionId),
      ]);
      try {
        const detail = await client.getAgentSessionDetail(next.sessionId);
        if (generation === generationRef.current) {
          setSessionDetails((current) => ({
            ...current,
            [detail.sessionId]: detail,
          }));
        }
      } catch {
        // The task remains visible when live detail is unavailable.
      }
    } catch (cause) {
      if (generation !== generationRef.current) return;
      setError(
        cause instanceof Error ? cause.message : "WTS could not start the agent.",
      );
    } finally {
      if (generation === generationRef.current) setBusy("idle");
    }
  };

  const stop = async (session: AgentSession) => {
    if (busy !== "idle") return;
    const generation = generationRef.current;
    setBusy("stopping");
    setError("");
    try {
      const next = await client.stopAgentSession(session.sessionId);
      if (generation !== generationRef.current) return;
      setSessions((current) =>
        current.map((item) =>
          item.sessionId === next.sessionId ? next : item,
        ),
      );
    } catch (cause) {
      if (generation !== generationRef.current) return;
      setError(
        cause instanceof Error ? cause.message : "WTS could not stop the agent.",
      );
    } finally {
      if (generation === generationRef.current) setBusy("idle");
    }
  };

  const activeSession = sessions.find((item) => isManagedActive(item)) ?? null;
  const active = activeSession !== null;
  const activeCount =
    sessions.filter((item) => isManagedActive(item)).length +
    observedSessions.filter((item) => item.status === "working").length;

  return (
    <section
      aria-label="Agent sessions"
      className={styles.panel}
      data-ui="agent-state.panel"
      data-ui-label="Agent state panel"
    >
      <div
        className={styles.heading}
        data-ui="agent-state.header"
        data-ui-label="Agent state header"
      >
        <div>
          <h2>Agent sessions</h2>
          <span>{activeCount} active</span>
        </div>
        <button
          disabled={busy !== "idle"}
          onClick={() => void refresh(true)}
          type="button"
        >
          Refresh
        </button>
      </div>

      <div
        className={styles.sessionList}
        aria-busy={busy === "loading" || undefined}
        data-ui="agent-state.sessions"
        data-ui-label="Live agent sessions"
      >
        {busy === "loading" && sessions.length === 0 && observedSessions.length === 0 ? (
          <p className={styles.empty}>WTS checks for agent sessions…</p>
        ) : sessions.length === 0 && observedSessions.length === 0 ? (
          <p className={styles.empty}>No agent session is visible in this workspace.</p>
        ) : (
          <>
            {observedSessions.map((observed) => (
              <article className={styles.sessionCard} key={`observed-${observed.sessionId}`}>
                <div className={styles.sessionSummary}>
                  <span
                    className={styles.stateDot}
                    data-state={observed.needsInput ? "interrupted" : observed.status}
                  />
                  <div>
                    <strong>{observationStatusLabel(observed)}</strong>
                    <small>{observed.provider === "copilot" ? "GitHub Copilot" : "Codex"} · VS Code · {observed.needsInput?.detail ?? observationActivityLabel(observed.activity)}</small>
                  </div>
                  <time>{heartbeatLabel(observed.lastEventAtUnixMs)}</time>
                </div>
                <dl className={styles.metadata}>
                  <div><dt>Model</dt><dd>{observed.model ?? `Selected by ${observed.provider === "copilot" ? "Copilot" : "Codex"}`}</dd></div>
                  <div><dt>Started</dt><dd>{heartbeatLabel(observed.startedAtUnixMs)}</dd></div>
                </dl>
                {observed.latestUpdate && (
                  <div className={styles.latestUpdate}>
                    <span>{observed.updateKind === "completion" ? "Final update" : "Latest update"}</span>
                    <p>{observed.latestUpdate}</p>
                  </div>
                )}
              </article>
            ))}
            {sessions.map((managed) => {
              const detail = sessionDetails[managed.sessionId];
              const visibleEvents = detail?.events.slice(-5) ?? [];
              return (
              <article className={styles.sessionCard} key={managed.sessionId}>
                <div className={styles.sessionSummary}>
                  <span className={styles.stateDot} data-state={managed.status} />
                  <div>
                    <strong>{sessionStatusLabel(managed)}</strong>
                    <small>{providerLabels[managed.provider]} · WTS background · {sessionDetail(managed)}</small>
                  </div>
                  {isManagedActive(managed) && (
                    <button
                      className={styles.failureAction}
                      disabled={busy !== "idle" || managed.status === "stopping"}
                      onClick={() => void stop(managed)}
                      type="button"
                    >
                      {busy === "stopping" || managed.status === "stopping" ? "Task stops…" : "Stop task"}
                    </button>
                  )}
                </div>
                <dl className={styles.metadata}>
                  <div><dt>Model</dt><dd>{detail?.modelSelection.model ?? "Provider default"}</dd></div>
                  {detail?.modelSelection.reasoningEffort && (
                    <div><dt>Effort</dt><dd>{detail.modelSelection.reasoningEffort}</dd></div>
                  )}
                  <div><dt>Started</dt><dd>{heartbeatLabel(managed.startedAtUnixMs)}</dd></div>
                </dl>
                {(detail?.task || (isManagedActive(managed) && submittedTask)) && (
                  <div className={styles.latestUpdate}>
                    <span>Task</span>
                    <p>{detail?.task ?? submittedTask}</p>
                  </div>
                )}
                {visibleEvents.length > 0 ? (
                  <ol className={styles.eventList} aria-label="Agent activity updates">
                    {visibleEvents.map((event) => (
                      <li key={event.sequence}>
                        <time>{heartbeatLabel(event.observedAtUnixMs)}</time>
                        <span>{event.summary}</span>
                      </li>
                    ))}
                  </ol>
                ) : isManagedActive(managed) ? (
                  <p className={styles.detailUnavailable}>Live activity is not available yet.</p>
                ) : null}
                {detail?.eventsTruncated && (
                  <small className={styles.detailUnavailable}>Earlier activity was removed from this live view.</small>
                )}
              </article>
              );
            })}
          </>
        )}
      </div>

      <p className={styles.visibilityNote}>
        WTS shows agent updates and activity summaries. It does not show hidden reasoning or raw tool arguments.
      </p>

      {!active && (
        <div
          className={styles.prompt}
          data-ui="agent-state.task-composer"
          data-ui-label="Background task composer"
        >
          <label htmlFor={taskFieldId}>Start a background task</label>
          <textarea
            aria-describedby={taskDisclosureId}
            disabled={!materialized || busy !== "idle"}
            id={taskFieldId}
            maxLength={16_384}
            onChange={(event) => setPrompt(event.target.value)}
            rows={3}
            value={prompt}
          />
          <small className={styles.disclosure} id={taskDisclosureId}>
            This starts a separate background process. It does not continue the
            Codex chat in VS Code. Its session appears above.
          </small>
          <div className={styles.actions}>
            <button
              className={styles.primaryAction}
              disabled={!materialized || busy !== "idle" || !prompt.trim()}
              onClick={() => void start()}
              type="button"
            >
              {busy === "starting"
                ? `${providerLabels[provider]} starts…`
                : `Run ${providerLabels[provider]} in background`}
            </button>
          </div>
        </div>
      )}
      {!materialized && (
        <p className={styles.note}>Create the workspace before you run a task.</p>
      )}
      {error && <p className={styles.error} role="alert">{error}</p>}
    </section>
  );
}
