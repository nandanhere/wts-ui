import { useEffect, useMemo, useRef, useState } from "react";
import type {
  BrowserJourneyReadiness,
  WorkspaceClient,
  WorkspaceTestRunDetail,
  WorkspaceTestRunState,
  WorkspaceTestRunSummary,
} from "../../lib/wtsClient";
import styles from "./UserJourneys.module.css";

const BUILT_IN_JOURNEY = {
  id: "wts-help-preferences",
  title: "Help + environment",
  description:
    "Opens the guide, verifies the working loop, then confirms the separate environment dialog opens.",
  steps: 12,
} as const;

type LoadState = "loading" | "ready" | "running" | "error";

function Icon({
  name,
}: {
  name: "assistant" | "check" | "error" | "journey" | "play" | "refresh";
}) {
  const paths = {
    assistant: (
      <>
        <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
        <path d="m6.3 6.3 2.1 2.1M15.6 15.6l2.1 2.1M17.7 6.3l-2.1 2.1M8.4 15.6l-2.1 2.1" />
        <circle cx="12" cy="12" r="3" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    error: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v6M12 17h.01" />
      </>
    ),
    journey: (
      <>
        <circle cx="6" cy="17" r="2" />
        <circle cx="18" cy="7" r="2" />
        <path d="M8 17h3a3 3 0 0 0 3-3v-4a3 3 0 0 1 3-3" />
      </>
    ),
    play: <path d="m8 5 11 7-11 7V5Z" />,
    refresh: (
      <path d="M20 7v5h-5M4 17v-5h5M18.5 10a7 7 0 0 0-12-3L4 10M5.5 14a7 7 0 0 0 12 3l2.5-3" />
    ),
  };

  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <g
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      >
        {paths[name]}
      </g>
    </svg>
  );
}

function statusLabel(state: WorkspaceTestRunState | undefined) {
  if (!state) return "Not run";
  return {
    passed: "Passed",
    failed: "Failed",
    cancelled: "Cancelled",
    timedOut: "Timed out",
    running: "Active",
  }[state];
}

function compactDuration(durationMs: number | null | undefined) {
  if (durationMs === null || durationMs === undefined) return "—";
  if (durationMs < 1_000) return `${durationMs} ms`;
  return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)} s`;
}

function currentLoopbackOrigin(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const origin = new URL(window.location.origin);
    const host = origin.hostname.toLowerCase();
    const loopback =
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "[::1]" ||
      host === "::1";
    if (
      !loopback ||
      (origin.protocol !== "http:" && origin.protocol !== "https:")
    ) {
      return null;
    }
    return window.location.origin;
  } catch {
    return null;
  }
}

function latestJourneyRun(runs: WorkspaceTestRunSummary[]) {
  return runs
    .filter((run) => run.journeyId === BUILT_IN_JOURNEY.id)
    .sort(
      (left, right) =>
        right.startedAtUnixMs - left.startedAtUnixMs ||
        right.runId.localeCompare(left.runId),
    )[0];
}

function failureContext(
  workspaceId: string,
  run: WorkspaceTestRunSummary,
  detail: WorkspaceTestRunDetail,
) {
  return [
    "WTS local user-journey failure",
    `Workspace ID: ${workspaceId}`,
    `Journey: ${run.title} (${run.journeyId})`,
    `Run ID: ${run.runId}`,
    `Status: ${statusLabel(run.state)}`,
    `Steps: ${run.passedSteps} passed, ${run.failedSteps} failed, ${run.totalSteps} total`,
    `Failed step: ${run.failedStepId ?? "Not reported"}`,
    `Failure: ${run.message ?? "No additional message"}`,
    `Artifacts: ${run.artifactsDisplayPath}`,
    `Integrity: ${detail.artifacts.length} artifact${detail.artifacts.length === 1 ? "" : "s"} SHA-256 verified immediately before this handoff`,
    `Graph: ${run.graphSha256 ?? "No graph digest attached"}`,
    "Boundary: this is deterministic local evidence. Agent advice must not change the journey or its assertions.",
  ].join("\n");
}

function failedState(state: WorkspaceTestRunState | undefined) {
  return state === "failed" || state === "timedOut" || state === "cancelled";
}

export function UserJourneys({
  client,
  workspaceId,
  workspaceKey,
  onNotice,
  onSendToAssistant,
  readiness,
  onOpenPreferences,
}: {
  client: WorkspaceClient;
  workspaceId: string;
  workspaceKey: string;
  onNotice: (message: string) => void;
  onSendToAssistant?: (prompt: string) => void;
  readiness?: BrowserJourneyReadiness;
  onOpenPreferences?: () => void;
}) {
  const supported = Boolean(
    client.listWorkspaceTestRuns && client.runWorkspaceTestJourney,
  );
  const [runs, setRuns] = useState<WorkspaceTestRunSummary[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [handoffState, setHandoffState] = useState<"idle" | "validating">(
    "idle",
  );
  const [error, setError] = useState("");
  const generation = useRef(0);
  const handoffIdentity = useRef<{
    client: WorkspaceClient;
    workspaceId: string;
    runId: string | null;
  }>({
    client,
    workspaceId,
    runId: null,
  });
  const loopbackOrigin = currentLoopbackOrigin();
  const runnerReady = readiness?.ready ?? true;
  const runnerBlock = readiness
    ? [
        readiness.node,
        readiness.fixedHelper,
        readiness.playwright,
        readiness.chromium,
      ].find((check) => check.status !== "ready")
    : undefined;

  const latest = useMemo(() => latestJourneyRun(runs), [runs]);
  handoffIdentity.current = {
    client,
    workspaceId,
    runId: latest?.runId ?? null,
  };
  const isRunning = state === "running" || latest?.state === "running";
  const completedSteps = latest
    ? Math.min(latest.totalSteps, latest.passedSteps + latest.failedSteps)
    : 0;
  const progress =
    latest && latest.totalSteps > 0
      ? Math.round((completedSteps / latest.totalSteps) * 100)
      : 0;

  const load = async (quiet = false) => {
    if (!client.listWorkspaceTestRuns) return;
    const requestGeneration = ++generation.current;
    if (!quiet) {
      setState("loading");
      setError("");
    }
    try {
      const result = await client.listWorkspaceTestRuns(workspaceId);
      if (requestGeneration !== generation.current) return;
      setRuns(result.runs);
      setState("ready");
      setError("");
    } catch (reason) {
      if (requestGeneration !== generation.current) return;
      setState("error");
      setError(
        reason instanceof Error
          ? reason.message
          : "Local user journeys could not be loaded.",
      );
    }
  };

  useEffect(() => {
    generation.current += 1;
    setRuns([]);
    setHandoffState("idle");
    setError("");
    if (!supported) {
      setState("ready");
      return;
    }
    void load();
    return () => {
      generation.current += 1;
    };
    // The selected workspace owns this small run projection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, supported, workspaceId]);

  useEffect(() => {
    if (
      !supported ||
      latest?.state !== "running" ||
      !client.listWorkspaceTestRuns
    ) {
      return;
    }

    let cancelled = false;
    let timer: number | undefined;
    const activeRunId = latest.runId;
    const poll = async () => {
      try {
        const result = await client.listWorkspaceTestRuns?.(workspaceId);
        if (cancelled || !result) return;
        setRuns(result.runs);
        setState("ready");
        setError("");
        if (result.runs.some((run) => run.runId === activeRunId && run.state === "running")) {
          timer = window.setTimeout(() => void poll(), 2_000);
        }
      } catch (reason) {
        if (cancelled) return;
        setState("error");
        setError(
          reason instanceof Error
            ? reason.message
            : "The active local journey could not be refreshed.",
        );
      }
    };
    timer = window.setTimeout(() => void poll(), 2_000);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [client, latest?.runId, latest?.state, supported, workspaceId]);

  if (!supported) return null;

  const run = async () => {
    if (
      !client.runWorkspaceTestJourney ||
      !loopbackOrigin ||
      !runnerReady ||
      isRunning
    ) {
      return;
    }
    const requestGeneration = ++generation.current;
    setState("running");
    setError("");
    onNotice(`${workspaceKey} · running local user journey…`);
    try {
      const result = await client.runWorkspaceTestJourney(workspaceId, {
        journeyId: BUILT_IN_JOURNEY.id,
        baseUrl: loopbackOrigin,
      });
      if (requestGeneration !== generation.current) return;
      setRuns((current) => [
        result,
        ...current.filter((run) => run.runId !== result.runId),
      ]);
      setState("ready");
      onNotice(
        `${workspaceKey} · user journey ${statusLabel(result.state).toLowerCase()}`,
      );
    } catch (reason) {
      if (requestGeneration !== generation.current) return;
      setState("error");
      setError(
        reason instanceof Error
          ? reason.message
          : "The local user journey could not run.",
      );
      onNotice(`${workspaceKey} · user journey could not run`);
    }
  };

  const sendToAssistant = async () => {
    if (
      !latest ||
      !failedState(latest.state) ||
      !onSendToAssistant ||
      !client.getWorkspaceTestRun ||
      handoffState === "validating"
    ) {
      return;
    }
    const requestGeneration = ++generation.current;
    const requestClient = client;
    const requestWorkspaceId = workspaceId;
    const requestWorkspaceKey = workspaceKey;
    const requestRun = latest;
    const requestIsCurrent = () => {
      const current = handoffIdentity.current;
      return (
        requestGeneration === generation.current &&
        current.client === requestClient &&
        current.workspaceId === requestWorkspaceId &&
        current.runId === requestRun.runId
      );
    };
    setHandoffState("validating");
    setError("");
    try {
      const detail = await requestClient.getWorkspaceTestRun!(
        requestWorkspaceId,
        requestRun.runId,
      );
      if (!requestIsCurrent()) return;
      if (
        detail.workspaceId !== requestWorkspaceId ||
        detail.runId !== requestRun.runId ||
        detail.journeyId !== requestRun.journeyId ||
        detail.state !== requestRun.state
      ) {
        throw new Error("The run detail no longer matches its summary.");
      }
      onSendToAssistant(failureContext(requestWorkspaceId, requestRun, detail));
      onNotice(
        `${requestWorkspaceKey} · verified journey evidence loaded in Assistant`,
      );
    } catch {
      if (!requestIsCurrent()) return;
      setError(
        "Journey evidence could not be integrity-checked. Rerun the journey before handing it to an agent.",
      );
      onNotice(
        `${requestWorkspaceKey} · journey evidence failed integrity check`,
      );
    } finally {
      if (!requestIsCurrent()) return;
      setHandoffState("idle");
    }
  };

  const effectiveState = isRunning ? "running" : latest?.state;
  const resultSteps = latest?.totalSteps ?? BUILT_IN_JOURNEY.steps;
  const stepSummary = latest
    ? `${latest.passedSteps} of ${resultSteps} steps passed`
    : `${BUILT_IN_JOURNEY.steps} fixed steps`;

  return (
    <section
      className={styles.section}
      aria-labelledby="user-journeys-title"
      data-state={effectiveState ?? "notRun"}
      data-ui="verification.user-journeys"
      data-ui-label="User journeys"
    >
      <header className={styles.header}>
        <span className={styles.icon}>
          <Icon name="journey" />
        </span>
        <div className={styles.heading}>
          <div className={styles.eyebrow}>
            <span>USER JOURNEYS</span>
            <i>Local</i>
            <i>Deterministic</i>
          </div>
          <h3 id="user-journeys-title">Test the workflow a user sees</h3>
          <p>
            A fixed browser journey runs against this WTS window and keeps its
            evidence on this machine.
          </p>
        </div>
      </header>

      <div
        className={styles.journey}
        data-ui="verification.journey-run"
        data-ui-label="Journey run"
      >
        <span className={styles.stateIcon} aria-hidden="true">
          {effectiveState === "passed" ? (
            <Icon name="check" />
          ) : failedState(effectiveState) ? (
            <Icon name="error" />
          ) : effectiveState === "running" ? (
            <i />
          ) : (
            <span />
          )}
        </span>
        <div className={styles.identity}>
          <b>{BUILT_IN_JOURNEY.title}</b>
          <small>{BUILT_IN_JOURNEY.description}</small>
        </div>
        <div className={styles.result} aria-live="polite">
          <b>{statusLabel(effectiveState)}</b>
          <small>
            {stepSummary}
            {latest?.durationMs !== null &&
              latest?.durationMs !== undefined &&
              ` · ${compactDuration(latest.durationMs)}`}
          </small>
        </div>
        <button
          className={styles.runButton}
          disabled={!loopbackOrigin || !runnerReady || isRunning}
          onClick={() => void run()}
        >
          {isRunning ? (
            <i />
          ) : latest ? (
            <Icon name="refresh" />
          ) : (
            <Icon name="play" />
          )}
          {isRunning ? "Run in progress" : latest ? "Rerun" : "Run"}
        </button>
        <div className={styles.timeline} aria-hidden="true">
          <span style={{ width: `${progress}%` }} />
        </div>
      </div>

      {!loopbackOrigin && (
        <p className={styles.boundary} role="status">
          This journey is available only from the local loopback WTS host.
        </p>
      )}

      {loopbackOrigin && !runnerReady && (
        <div className={styles.boundary} role="status">
          <span>
            {runnerBlock?.detail ??
              "The local browser runner needs setup before this journey can run."}
          </span>
          {onOpenPreferences && (
            <button onClick={onOpenPreferences}>
              Open Environment &amp; integrations
            </button>
          )}
        </div>
      )}

      {error && (
        <div className={styles.inlineError} role="alert">
          <Icon name="error" />
          <span>{error}</span>
          <button onClick={() => void load()}>
            <Icon name="refresh" /> Retry
          </button>
        </div>
      )}

      {state === "loading" && !latest && (
        <div className={styles.loading} role="status">
          <i />
          WTS reads local journey evidence…
        </div>
      )}

      {latest && (
        <details
          className={styles.evidence}
          data-ui="verification.run-evidence"
          data-ui-label="Run evidence"
        >
          <summary>
            <span>Run evidence</span>
            <small>{latest.artifactsDisplayPath}</small>
            <i aria-hidden="true">›</i>
          </summary>
          <div>
            <dl>
              <span>
                <dt>Run</dt>
                <dd>{latest.runId}</dd>
              </span>
              <span>
                <dt>Started</dt>
                <dd>
                  {new Date(latest.startedAtUnixMs).toLocaleString([], {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </dd>
              </span>
              <span>
                <dt>Artifacts</dt>
                <dd>
                  <code>{latest.artifactsDisplayPath}</code>
                </dd>
              </span>
            </dl>
            {failedState(latest.state) &&
              onSendToAssistant &&
              client.getWorkspaceTestRun && (
              <aside className={styles.handoff}>
                <span>
                  <b>{latest.failedStepId ?? "Journey needs attention"}</b>
                  <small>
                    {latest.message ??
                      "Review the deterministic evidence before asking an agent for advice."}
                  </small>
                </span>
                <button
                  disabled={handoffState === "validating"}
                  onClick={() => void sendToAssistant()}
                >
                  <Icon name="assistant" />{" "}
                  {handoffState === "validating"
                    ? "Checking evidence…"
                    : "Review with Assistant"}
                </button>
              </aside>
            )}
          </div>
        </details>
      )}
    </section>
  );
}
