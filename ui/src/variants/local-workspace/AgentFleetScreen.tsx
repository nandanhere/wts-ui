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
  providerFailed: "The agent CLI failed. Open the workspace to check the files, then start the task again.",
  processExited: "The agent stopped before it gave a result. Open the workspace to check the files, then start the task again.",
  staleHeartbeat: "The agent stopped sending a heartbeat. Open the workspace to check the files, then start the task again.",
  launchOutcomeUnknown: "The launch result is unknown.",
  userStopped: "You stopped this session.",
};

const DISMISSED_KEY = "wts.agents.dismissed-errors.v1";

function loadDismissed(): ReadonlySet<string> {
  try {
    const value: unknown = JSON.parse(globalThis.localStorage?.getItem(DISMISSED_KEY) ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === "string").slice(-200) : []);
  } catch {
    return new Set();
  }
}

function saveDismissed(ids: ReadonlySet<string>) {
  try {
    globalThis.localStorage?.setItem(DISMISSED_KEY, JSON.stringify([...ids].slice(-200)));
  } catch {
    // The dismissal still applies until the screen closes.
  }
}

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
  dismissed: ReadonlySet<string> = new Set(),
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
      const reported = managedHealth(session, now);
      // A dismissed error is history. It no longer asks for the user.
      const health = reported === "error" && dismissed.has("managed:" + session.sessionId) ? "finished" : reported;
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

/** A session that works, starts, or needs the user. It shows as a full card. */
export function isCurrent(card: FleetCard) {
  return card.health === "working" || card.health === "starting" || card.health === "waiting" || card.health === "error";
}

/** Groups idle and finished sessions by workspace. The most recent workspace comes first. */
export function groupEarlierSessions(cards: readonly FleetCard[]) {
  const groups = new Map<string, FleetCard[]>();
  for (const card of [...cards].filter((card) => !isCurrent(card)).sort((left, right) => right.lastSignalAtUnixMs - left.lastSignalAtUnixMs)) {
    const group = groups.get(card.workspaceId) ?? [];
    group.push(card);
    groups.set(card.workspaceId, group);
  }
  return [...groups].map(([workspaceId, group]) => ({ workspaceId, cards: group }));
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
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(() => new Set());
  const [openLog, setOpenLog] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, AgentSessionDetail | "loading" | "error" | "gone">>({});
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(loadDismissed);
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

  const cards = useMemo(() => buildFleetCards(sessions, observed, now, dismissed), [dismissed, now, observed, sessions]);
  const dismiss = (card: FleetCard) => {
    setDismissed((current) => {
      const next = new Set(current).add(card.id);
      saveDismissed(next);
      return next;
    });
    if (openLog === card.id) setOpenLog(null);
  };
  const current = cards.filter(isCurrent);
  const earlierGroups = useMemo(() => groupEarlierSessions(cards), [cards]);
  const earlierCount = cards.length - current.length;
  const agentMsToday = cards.reduce((total, card) => total + card.workedTodayMs, 0);
  const attentionCount = cards.filter((card) => card.health === "waiting" || card.health === "error").length;
  const workingCount = cards.filter((card) => card.health === "working" || card.health === "starting").length;

  const toggleGroup = (workspaceId: string) =>
    setOpenGroups((open) => {
      const next = new Set(open);
      if (next.has(workspaceId)) next.delete(workspaceId);
      else next.add(workspaceId);
      return next;
    });

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
        .catch((cause: unknown) => {
          const gone = typeof cause === "object" && cause !== null && "code" in cause && cause.code === "agent_session_not_found";
          if (mounted.current && currentClient.current === client) setDetails((current) => ({ ...current, [card.sessionId]: gone ? "gone" : "error" }));
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

  const renderLog = (card: FleetCard) => {
    const detail = details[card.sessionId];
    return (
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
        {card.kind === "managed" && detail === "gone" && (
          <p role="status">This log is not available. The log of a background agent stays in memory only until the app restarts, and the app restarted after this session.</p>
        )}
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
    );
  };

  const renderCard = (card: FleetCard) => {
    const workspace = workspaceLabels[card.workspaceId];
    const live = card.health === "working" && now - card.lastSignalAtUnixMs < 90_000;
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
        <p className={styles.cardMeta}>
          {formatDuration(card.workedTodayMs)} today · last signal{" "}
          <time dateTime={new Date(card.lastSignalAtUnixMs).toISOString()}>
            {relativeTime(card.lastSignalAtUnixMs, now)}
          </time>
        </p>
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
            {card.kind === "managed" && card.health === "error" && (
              <button
                aria-label={"Dismiss the " + card.providerLabel + " error"}
                className={styles.ghost}
                data-ui="fleet.dismiss-error"
                data-ui-label="Dismiss agent error"
                onClick={() => dismiss(card)}
                title="Move this session to Earlier sessions"
                type="button"
              >
                Dismiss
              </button>
            )}
          </div>
        )}
        {openLog === card.id && renderLog(card)}
      </li>
    );
  };

  return (
    <main className={styles.page} data-ui="fleet.page" data-ui-label="Agents page">
      <header className={styles.header}>
        <div>
          <h1>Agents</h1>
          <p>Agents that work or need you show first. Earlier sessions are grouped by workspace.</p>
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
          <strong>{workingCount}</strong>
        </div>
        <div className={styles.kpi} data-tone="attention">
          <span>Needs you</span>
          <strong>{attentionCount}</strong>
        </div>
        <div className={styles.kpi} data-tone="agent">
          <span>Agent work today</span>
          <strong>{formatDuration(agentMsToday)}</strong>
        </div>
      </section>

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

      {cards.length > 0 && (
        <section className={styles.section} aria-labelledby="fleet-current-heading" data-ui="fleet.current" data-ui-label="Current agents">
          <h2 className={styles.sectionHeading} id="fleet-current-heading">
            Now <span className={styles.count}>{current.length}</span>
          </h2>
          {current.length === 0 ? (
            <p className={styles.quietNote}>No agent works or needs you now.</p>
          ) : (
            <ol className={styles.grid} aria-label="Agent sessions" data-ui="fleet.sessions" data-ui-label="Agent sessions">
              {current.map((card) => renderCard(card))}
            </ol>
          )}
        </section>
      )}

      {earlierGroups.length > 0 && (
        <section className={styles.section} aria-labelledby="fleet-earlier-heading" data-ui="fleet.earlier" data-ui-label="Earlier sessions">
          <h2 className={styles.sectionHeading} id="fleet-earlier-heading">
            Earlier sessions <span className={styles.count}>{earlierCount}</span>
          </h2>
          <ul className={styles.groups} aria-label="Earlier sessions by workspace">
            {earlierGroups.map((group) => {
              const workspace = workspaceLabels[group.workspaceId];
              const title = workspace?.title ?? "Workspace not saved";
              const open = openGroups.has(group.workspaceId);
              const latest = group.cards[0];
              return (
                <li className={styles.group} key={group.workspaceId}>
                  <div className={styles.groupHeader}>
                    <button
                      aria-expanded={open}
                      className={styles.groupToggle}
                      onClick={() => toggleGroup(group.workspaceId)}
                      type="button"
                    >
                      <Glyph name="chevron" size={12} />
                      <Glyph name="folder" size={13} />
                      <strong>{title}</strong>
                      <span>
                        {group.cards.length} {group.cards.length === 1 ? "session" : "sessions"} · last {relativeTime(latest.lastSignalAtUnixMs, now)}
                      </span>
                    </button>
                    {workspace && (
                      <button
                        aria-label={"Open workspace " + title}
                        className={styles.ghost}
                        onClick={() => onOpenWorkspace(group.workspaceId)}
                        type="button"
                      >
                        Open workspace
                      </button>
                    )}
                  </div>
                  {open && (
                    <ol className={styles.rows} aria-label={"Earlier sessions in " + title}>
                      {group.cards.map((card) => (
                        <li className={styles.row} key={card.id}>
                          <div className={styles.rowLine}>
                            <span className={styles.rowDot} data-health={card.health} aria-hidden="true" />
                            <span className={styles.rowStatus}>{card.healthLabel}</span>
                            <span className={styles.rowMeta}>
                              {card.providerLabel}
                              {card.model ? " · " + card.model : " · " + card.surface}
                            </span>
                            <span className={styles.rowPreview} title={card.task}>{updatePreview(card.task)}</span>
                            <time dateTime={new Date(card.lastSignalAtUnixMs).toISOString()}>
                              {relativeTime(card.lastSignalAtUnixMs, now)}
                            </time>
                            <button
                              aria-expanded={openLog === card.id}
                              className={styles.ghost}
                              onClick={() => toggleLog(card)}
                              type="button"
                            >
                              {openLog === card.id ? "Hide log" : "Log"}
                            </button>
                          </div>
                          {openLog === card.id && renderLog(card)}
                        </li>
                      ))}
                    </ol>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </main>
  );
}
