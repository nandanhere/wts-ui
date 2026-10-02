import { subscribeAppRefresh } from "../../lib/appRefresh";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invalidateAgentSessions, loadAgentSessions } from "../../lib/agentSessionDiscovery";
import type {
  AgentSession,
  AgentSessionDetail,
  ObservedAgentSession,
  WorkspaceClient,
} from "../../lib/wtsClient";
import { Glyph } from "./Glyph";
import { agentBlocksInRange, formatDuration } from "./hybridTime";
import styles from "./AgentFleetScreen.module.css";

const REFRESH_MS = 5_000;
/** A failure older than this is history. It no longer asks for the user. */
export const ATTENTION_WINDOW_MS = 24 * 60 * 60 * 1_000;
/** A launch without a heartbeat for this long is not live. */
const LAUNCH_WINDOW_MS = 30 * 60 * 1_000;

export type FleetHealth = "working" | "waiting" | "error" | "starting" | "idle" | "finished";

export interface FleetCard {
  id: string;
  kind: "observed" | "managed";
  sessionId: string;
  workspaceId: string;
  providerLabel: string;
  surface: string;
  model: string | null;
  health: FleetHealth;
  healthLabel: string;
  task: string;
  startedAtUnixMs: number;
  lastSignalAtUnixMs: number;
  workedTodayMs: number;
  canStop: boolean;
  observed?: ObservedAgentSession;
}

const healthLabels: Record<FleetHealth, string> = {
  working: "Working",
  waiting: "Waiting for input",
  error: "Error",
  starting: "Starting",
  idle: "Idle",
  finished: "Finished",
};

const healthOrder: Record<FleetHealth, number> = {
  waiting: 0,
  error: 1,
  working: 2,
  starting: 3,
  idle: 4,
  finished: 5,
};

const activityLabels: Record<string, string> = {
  thinking: "Thinking…",
  usingTools: "Using tools…",
  editing: "Editing files…",
  runningCommand: "Running a command…",
  searching: "Searching…",
  delegating: "Delegating to a subagent…",
};

const providerNames: Record<string, string> = {
  codex: "Codex",
  openCode: "OpenCode",
  hermes: "Hermes",
  copilot: "GitHub Copilot",
};

const failureText: Record<string, string> = {
  launchRejected: "The terminal did not start the agent.",
  providerFailed: "The agent CLI failed.",
  processExited: "The agent process stopped.",
  staleHeartbeat: "The agent stopped sending a heartbeat.",
  launchOutcomeUnknown: "The launch result is unknown.",
  userStopped: "You stopped this session.",
};

function dayStart(now: number) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start.getTime();
}

function workedToday(session: ObservedAgentSession, now: number) {
  return agentBlocksInRange([], [session], { startedAtUnixMs: dayStart(now), endedAtUnixMs: now }, now)
    .reduce((total, block) => total + block.durationMs, 0);
}

function observedHealth(session: ObservedAgentSession, now: number): FleetHealth {
  const recent = now - session.lastEventAtUnixMs < ATTENTION_WINDOW_MS;
  if (session.needsInput) return recent ? "waiting" : "finished";
  if (session.status === "working") return "working";
  if (session.status === "interrupted") return recent ? "error" : "finished";
  if (session.status === "stale") return "finished";
  return "idle";
}

function managedHealth(session: AgentSession, now: number): FleetHealth {
  const lastSignal = session.endedAtUnixMs ?? session.lastHeartbeatAtUnixMs;
  const recent = now - lastSignal < ATTENTION_WINDOW_MS;
  if (session.needsInput) return recent ? "waiting" : "finished";
  if ((session.status === "launching" || session.status === "handoffAccepted") && now - lastSignal > LAUNCH_WINDOW_MS) {
    return "finished";
  }
  if ((session.status === "failed" || (session.status === "interrupted" && session.failure !== "userStopped")) && !recent) {
    return "finished";
  }
  switch (session.status) {
    case "running":
    case "stopping":
      return "working";
    case "launching":
    case "handoffAccepted":
      return "starting";
    case "failed":
      return "error";
    case "interrupted":
      return session.failure === "userStopped" ? "finished" : "error";
    default:
      return "finished";
  }
}

/** Builds one card for each agent session. Sessions that need the user come first. */
export function buildFleetCards(
  sessions: readonly AgentSession[],
  observed: readonly ObservedAgentSession[],
  now: number,
): FleetCard[] {
  const cards: FleetCard[] = [
    ...observed.map((session): FleetCard => {
      const health = observedHealth(session, now);
      return {
        id: "observed:" + session.sessionId,
        kind: "observed",
        sessionId: session.sessionId,
        workspaceId: session.workspaceId,
        providerLabel: providerNames[session.provider] ?? session.provider,
        surface: "VS Code",
        model: session.model ?? null,
        health,
        healthLabel: health === "waiting" && session.needsInput ? session.needsInput.detail : healthLabels[health],
        task:
          session.latestUpdate?.trim() ||
          (session.status === "working" && session.activity
            ? activityLabels[session.activity] ?? "Working…"
            : "No update from the agent yet."),
        startedAtUnixMs: session.startedAtUnixMs,
        lastSignalAtUnixMs: session.lastEventAtUnixMs,
        workedTodayMs: workedToday(session, now),
        canStop: false,
        observed: session,
      };
    }),
    ...sessions.map((session): FleetCard => {
      const health = managedHealth(session, now);
      const running = session.status === "running";
      return {
        id: "managed:" + session.sessionId,
        kind: "managed",
        sessionId: session.sessionId,
        workspaceId: session.workspaceId,
        providerLabel: providerNames[session.provider] ?? session.provider,
        surface: session.terminal === "warp" ? "Warp" : "Terminal",
        model: null,
        health,
        healthLabel:
          health === "finished" && session.status === "failed"
            ? "Failed"
            : health === "finished" && session.status === "interrupted" && session.failure !== "userStopped"
              ? "Stopped"
              : health === "finished" && (session.status === "launching" || session.status === "handoffAccepted")
                ? "Launch not confirmed"
                : session.needsInput && health === "waiting"
                  ? session.needsInput.detail
                  : session.status === "stopping"
                    ? "Stopping…"
                    : healthLabels[health],
        task:
          (session.failure && failureText[session.failure]) ||
          (session.category === "uncategorized"
            ? "Background task"
            : "Background " + session.category + " task"),
        startedAtUnixMs: session.startedAtUnixMs,
        lastSignalAtUnixMs: session.endedAtUnixMs ?? session.lastHeartbeatAtUnixMs,
        workedTodayMs: agentBlocksInRange([session], [], { startedAtUnixMs: dayStart(now), endedAtUnixMs: now }, now).reduce((total, block) => total + block.durationMs, 0),
        canStop: running,
      };
    }),
  ];
  return cards.sort(
    (left, right) =>
      healthOrder[left.health] - healthOrder[right.health] ||
      right.lastSignalAtUnixMs - left.lastSignalAtUnixMs,
  );
}

export function relativeTime(fromUnixMs: number, now: number) {
  const seconds = Math.max(0, Math.round((now - fromUnixMs) / 1_000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return seconds + "s ago";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + "m ago";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + "h ago";
  return Math.floor(hours / 24) + "d ago";
}

type Filter = "all" | "active" | "attention" | "done";

const filterLabels: Record<Filter, string> = {
  all: "All",
  active: "Working",
  attention: "Needs you",
  done: "Idle and finished",
};

function matchesFilter(card: FleetCard, filter: Filter) {
  if (filter === "all") return true;
  if (filter === "active") return card.health === "working" || card.health === "starting";
  if (filter === "attention") return card.health === "waiting" || card.health === "error";
  return card.health === "idle" || card.health === "finished";
}

function updatePreview(text: string): string {
  const line = text.split("\n").find(line => line.trim() && !line.trim().startsWith("```")) ?? text;
  return line.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[*`#>]/g, "").replace(/^[-+]\s+/, "").trim();
}

const timeOfDay = (unixMs: number, seconds = false) =>
  new Date(unixMs).toLocaleTimeString([], seconds
    ? { hour: "2-digit", minute: "2-digit", second: "2-digit" }
    : { hour: "2-digit", minute: "2-digit" });

export function AgentFleetScreen({
  client,
  workspaceLabels,
  onOpenWorkspace,
  onOpenInVscode,
  onOpenTime,
}: {
  client: WorkspaceClient;
  workspaceLabels: Record<string, { key: string; title: string }>;
  onOpenWorkspace: (workspaceId: string) => void;
  onOpenInVscode: (workspaceId: string) => void;
  onOpenTime: () => void;
}) {
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [observed, setObserved] = useState<ObservedAgentSession[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [filter, setFilter] = useState<Filter>("all");
  const [openLog, setOpenLog] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, AgentSessionDetail | "loading" | "error">>({});
  const [confirmStop, setConfirmStop] = useState<string | null>(null);
  const [stopError, setStopError] = useState<Record<string, string>>({});
  const refreshes = useRef(0);
  const mounted = useRef(true);
  const currentClient = useRef(client);
  currentClient.current = client;

  const refresh = useCallback(
    async (force = false) => {
      try {
        const list = await loadAgentSessions(client, undefined, { force });
        if (!mounted.current || currentClient.current !== client) return;
        setSessions(list.sessions);
        setObserved(list.observedSessions ?? []);
        setState("ready");
        setError("");
        setUpdatedAt(Date.now());
      } catch (cause) {
        if (!mounted.current || currentClient.current !== client) return;
        setState((current) => (current === "ready" ? current : "error"));
        setError(cause instanceof Error ? cause.message : "Cannot read agent sessions.");
      }
    },
    [client],
  );

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const unsubscribe = subscribeAppRefresh(client, () => { refreshes.current = 0; void refresh(true); });
    const timer = window.setInterval(() => {
      refreshes.current += 1;
      if (document.hidden) return;
      void refresh();
    }, REFRESH_MS);
    const ticker = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      unsubscribe();
      mounted.current = false;
      window.clearInterval(timer);
      window.clearInterval(ticker);
    };
  }, [refresh]);

  const cards = useMemo(() => buildFleetCards(sessions, observed, now), [now, observed, sessions]);
  const counts = useMemo(() => {
    const result: Record<Filter, number> = { all: cards.length, active: 0, attention: 0, done: 0 };
    for (const card of cards) {
      for (const key of ["active", "attention", "done"] as const) {
        if (matchesFilter(card, key)) result[key] += 1;
      }
    }
    return result;
  }, [cards]);
  const agentMsToday = cards.reduce((total, card) => total + card.workedTodayMs, 0);
  const visible = cards.filter((card) => matchesFilter(card, filter));

  const toggleLog = (card: FleetCard) => {
    if (openLog === card.id) {
      setOpenLog(null);
      return;
    }
    setOpenLog(card.id);
    if (card.kind === "managed" && (!details[card.sessionId] || details[card.sessionId] === "error")) {
      setDetails((current) => ({ ...current, [card.sessionId]: "loading" }));
      client
        .getAgentSessionDetail(card.sessionId)
        .then((detail) => {
          if (mounted.current && currentClient.current === client) setDetails((current) => ({ ...current, [card.sessionId]: detail }));
        })
        .catch(() => {
          if (mounted.current && currentClient.current === client) setDetails((current) => ({ ...current, [card.sessionId]: "error" }));
        });
    }
  };

  const stop = async (card: FleetCard) => {
    setConfirmStop(null);
    try {
      await client.stopAgentSession(card.sessionId);
      invalidateAgentSessions(client, card.workspaceId);
      await refresh(true);
    } catch (cause) {
      setStopError((current) => ({
        ...current,
        [card.sessionId]: cause instanceof Error ? cause.message : "Could not stop the session.",
      }));
    }
  };

  return (
    <main className={styles.page} data-ui="fleet.page" data-ui-label="Agents page">
      <header className={styles.header}>
        <div>
          <h1>Agents</h1>
          <p>Every agent session in your workspaces. Sessions that need you come first.</p>
        </div>
        <div className={styles.headerActions}>
          <span className={styles.updated} aria-live="polite">
            {state === "loading" && updatedAt === 0
              ? "Reading sessions…"
              : updatedAt > 0
                ? "Updated " + relativeTime(updatedAt, now)
                : ""}
          </span>
          <button className={styles.secondary} onClick={onOpenTime} type="button">
            My time
          </button>
          <button
            aria-label="Refresh agent sessions"
            className={styles.secondary}
            onClick={() => void refresh(true)}
            type="button"
          >
            <Glyph name="refresh" size={13} /> Refresh
          </button>
        </div>
      </header>

      <section className={styles.kpis} aria-label="Agent summary" data-ui="fleet.summary" data-ui-label="Agent summary">
        <div className={styles.kpi} data-tone="working">
          <span>Working now</span>
          <strong>{counts.active}</strong>
        </div>
        <div className={styles.kpi} data-tone="attention">
          <span>Needs you</span>
          <strong>{counts.attention}</strong>
        </div>
        <div className={styles.kpi}>
          <span>Idle or finished</span>
          <strong>{counts.done}</strong>
        </div>
        <div className={styles.kpi} data-tone="agent">
          <span>Agent work today</span>
          <strong>{formatDuration(agentMsToday)}</strong>
        </div>
      </section>

      <div className={styles.toolbar} role="group" aria-label="Filter agent sessions" data-ui="fleet.filter" data-ui-label="Agent filter">
        {(Object.keys(filterLabels) as Filter[]).map((key) => (
          <button
            aria-pressed={filter === key}
            className={styles.filter}
            key={key}
            onClick={() => setFilter(key)}
            type="button"
          >
            {filterLabels[key]}
            <span className={styles.count}>{counts[key]}</span>
          </button>
        ))}
      </div>

      {state === "loading" && cards.length === 0 && (
        <div className={styles.grid} role="status" aria-label="Reading agent sessions…">
          {[0, 1, 2].map((index) => (
            <div className={styles.skeletonCard} key={index}>
              <span className={styles.skeleton} data-size="title" />
              <span className={styles.skeleton} />
              <span className={styles.skeleton} data-size="short" />
            </div>
          ))}
        </div>
      )}
      {error && (
        <div className={styles.callout} role="alert">
          <Glyph name="warning" size={16} />
          <div>
            <strong>Cannot read agent sessions.</strong>
            <p>{error}</p>
          </div>
          <button className={styles.secondary} onClick={() => void refresh(true)} type="button">
            Try again
          </button>
        </div>
      )}
      {state === "ready" && cards.length === 0 && (
        <div className={styles.empty}>
          <Glyph name="terminal" size={20} />
          <strong>No agent sessions yet.</strong>
          <span>Open Codex or Copilot in a saved workspace in VS Code, or start a background task from a workspace. The session shows here.</span>
        </div>
      )}
      {state === "ready" && cards.length > 0 && visible.length === 0 && (
        <div className={styles.empty}>
          <strong>No sessions match this filter.</strong>
          <button className={styles.link} onClick={() => setFilter("all")} type="button">Show all sessions</button>
        </div>
      )}

      {visible.length > 0 && (
        <ol className={styles.grid} aria-label="Agent sessions" data-ui="fleet.sessions" data-ui-label="Agent sessions">
          {visible.map((card) => {
            const workspace = workspaceLabels[card.workspaceId];
            const live = card.health === "working" && now - card.lastSignalAtUnixMs < 90_000;
            const detail = details[card.sessionId];
            const elapsedEnd = card.health === "working" || card.health === "starting" ? now : card.lastSignalAtUnixMs;
            return (
              <li
                aria-label={card.providerLabel + " in " + (workspace?.title ?? "an unsaved workspace")}
                className={styles.card}
                data-health={card.health}
                key={card.id}
              >
                <div className={styles.cardTop}>
                  <span className={styles.provider}>
                    <span className={styles.providerMark} aria-hidden="true">{card.providerLabel.slice(0, 1)}</span>
                    <span>
                      <strong>{card.providerLabel}</strong>
                      <small>
                        {card.surface}
                        {card.model ? <> · <code>{card.model}</code></> : card.kind === "observed" ? " · Provider model" : ""}
                      </small>
                    </span>
                  </span>
                  <span className={styles.health} data-health={card.health}>
                    <span className={styles.healthDot} data-live={live || undefined} aria-hidden="true" />
                    {card.healthLabel}
                  </span>
                </div>
                <div className={styles.workspace}>
                  <Glyph name="folder" size={13} />
                  <strong>{workspace?.title ?? "Workspace not saved"}</strong>
                </div>
                <p className={styles.task} title={card.task}>{updatePreview(card.task)}</p>
                <dl className={styles.metrics}>
                  <div>
                    <dt>Session span</dt>
                    <dd>{formatDuration(Math.max(0, elapsedEnd - card.startedAtUnixMs))}</dd>
                  </div>
                  <div>
                    <dt>Worked today</dt>
                    <dd>{formatDuration(card.workedTodayMs)}</dd>
                  </div>
                  <div>
                    <dt>Last signal</dt>
                    <dd>
                      <time dateTime={new Date(card.lastSignalAtUnixMs).toISOString()}>
                        {relativeTime(card.lastSignalAtUnixMs, now)}
                      </time>
                    </dd>
                  </div>
                </dl>
                {stopError[card.sessionId] && (
                  <p className={styles.cardError} role="alert">{stopError[card.sessionId]}</p>
                )}
                {confirmStop === card.id ? (
                  <div className={styles.confirm} role="group" aria-label="Confirm stop">
                    <span>Stop this agent? Saved files stay in the workspace.</span>
                    <button className={styles.danger} onClick={() => void stop(card)} type="button">Stop agent</button>
                    <button className={styles.ghost} onClick={() => setConfirmStop(null)} type="button">Keep running</button>
                  </div>
                ) : (
                  <div className={styles.actions}>
                    <button
                      className={styles.primary}
                      disabled={!workspace}
                      onClick={() => onOpenWorkspace(card.workspaceId)}
                      type="button"
                    >
                      Open workspace
                    </button>
                    <button
                      aria-label="Open in VS Code"
                      className={styles.secondary}
                      disabled={!workspace}
                      onClick={() => onOpenInVscode(card.workspaceId)}
                      type="button"
                    >
                      <Glyph name="code" size={13} /> VS Code
                    </button>
                    <button
                      aria-expanded={openLog === card.id}
                      className={styles.ghost}
                      onClick={() => toggleLog(card)}
                      type="button"
                    >
                      {openLog === card.id ? "Hide log" : "Inspect log"}
                    </button>
                    {card.canStop && (
                      <button
                        aria-label={"Stop " + card.providerLabel}
                        className={styles.ghostDanger}
                        onClick={() => setConfirmStop(card.id)}
                        type="button"
                      >
                        <Glyph name="stop" size={13} /> Stop
                      </button>
                    )}
                  </div>
                )}
                {openLog === card.id && (
                  <div className={styles.log} aria-label={"Log for " + card.providerLabel} role="region">
                    {card.kind === "observed" && card.observed && (
                      <>
                        {card.observed.latestUpdate && <p className={styles.logUpdate}>{card.observed.latestUpdate}</p>}
                        <ol>
                          {(card.observed.workPeriods ?? []).slice(-8).reverse().map((period) => (
                            <li key={period.startedAtUnixMs}>
                              <time>{timeOfDay(period.startedAtUnixMs)}</time>
                              <span>{period.ongoing ? "Turn in progress" : "Turn finished"}</span>
                              <b>{formatDuration((period.ongoing ? now : period.endedAtUnixMs) - period.startedAtUnixMs)}</b>
                            </li>
                          ))}
                        </ol>
                        {(card.observed.workPeriods ?? []).length === 0 && <p>No turns recorded.</p>}
                      </>
                    )}
                    {card.kind === "managed" && detail === "loading" && <p role="status">Reading the session log…</p>}
                    {card.kind === "managed" && detail === "error" && <p role="alert">Cannot read the session log.</p>}
                    {card.kind === "managed" && detail && typeof detail === "object" && (
                      <>
                        <p className={styles.logUpdate}>{detail.task}</p>
                        <ol>
                          {detail.events.slice(-12).reverse().map((event) => (
                            <li key={event.sequence}>
                              <time>{timeOfDay(event.observedAtUnixMs, true)}</time>
                              <span>{event.summary}</span>
                            </li>
                          ))}
                        </ol>
                        {detail.events.length === 0 && <p>No events recorded.</p>}
                      </>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </main>
  );
}
