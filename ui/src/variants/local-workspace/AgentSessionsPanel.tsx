import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CSSProperties } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import type {
  ActivityWatchDailyReview,
  ActivityWatchStatus,
  AgentProvider,
  AgentSession,
  AgentSessionStatus,
  JiraActiveIssueList,
  ObservedAgentSession,
  WorkspaceClient,
} from "../../lib/wtsClient";
import {
  loadActivityWatchReviewHistory,
  loadActivityWatchReviewSnapshot,
  localDateKey,
  saveActivityWatchReviewSnapshot,
  type ActivityWatchReviewIntervalSnapshot,
} from "./activityWatchReviewCache";
import {
  isApplicationIgnored,
  loadIgnoredApplications,
  saveIgnoredApplications,
} from "./activityWatchIgnoredApplications";
import { suggestJiraIssues } from "./activityWatchSuggestions";
import {
  desktopNotificationState,
  requestDesktopNotifications,
  type DesktopNotificationState,
} from "./desktopNotifications";
import { buildTimeReviewAgentBrief } from "./timeReviewAgentBrief";
import {
  announceTimeReviewSnapshot,
  loadTimeReviewSchedule,
  saveTimeReviewSchedule,
  subscribeTimeReviewSchedule,
  subscribeTimeReviewSnapshot,
  timeReviewIntervals,
  type TimeReviewIntervalHours,
} from "./timeReviewSchedule";
import styles from "./AgentSessionsPanel.module.css";

const REFRESH_INTERVAL_MS = 5_000;
const MAX_AUTOMATIC_REFRESHES = 120;

type ReadState = "loading" | "ready" | "error";
type ReviewState = "idle" | ReadState;

const providerLabels: Record<AgentProvider, string> = {
  codex: "Codex",
  openCode: "OpenCode",
  hermes: "Hermes",
};

const statusLabels: Record<AgentSessionStatus, string> = {
  launching: "Terminal launch pending",
  handoffAccepted: "Terminal handoff accepted",
  running: "Agent active",
  stopping: "WTS stops the agent",
  completed: "Agent finished",
  failed: "Agent failed",
  interrupted: "Agent interrupted",
};

function durationLabel(session: AgentSession, now: number) {
  if (
    session.status === "launching" ||
    session.status === "handoffAccepted"
  ) {
    return "Not observed";
  }
  const end = session.endedAtUnixMs ?? now;
  const seconds = Math.max(0, Math.floor((end - session.startedAtUnixMs) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function categoryLabel(category: AgentSession["category"]) {
  return category === "uncategorized"
    ? "Uncategorized"
    : category.charAt(0).toUpperCase() + category.slice(1);
}

function failureLabel(failure: AgentSession["failure"]) {
  switch (failure) {
    case "launchRejected":
      return "Launch rejected";
    case "providerFailed":
      return "Provider failed";
    case "processExited":
      return "Process exited";
    case "staleHeartbeat":
      return "Heartbeat expired";
    case "launchOutcomeUnknown":
      return "Launch outcome unknown";
    case "userStopped":
      return "Stopped by user";
    case null:
      return null;
  }
}

function activityWatchLabel(status: ActivityWatchStatus | null) {
  if (!status) return "Not checked";
  if (status.state === "running") {
    return status.serverVersion
      ? `Connected · ${status.serverVersion}`
      : "Connected";
  }
  if (status.state === "incompatible") return "Needs attention";
  return status.installation === "detected" ? "Not running" : "Not detected";
}

function compactDuration(seconds: number) {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function activityRangeLabel(startedAtUnixMs: number, endedAtUnixMs: number) {
  const format = (value: number) =>
    new Date(value).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  return `${format(startedAtUnixMs)}–${format(endedAtUnixMs)}`;
}

function intervalDateLabel(startedAtUnixMs: number, endedAtUnixMs: number) {
  const start = new Date(startedAtUnixMs);
  const end = new Date(endedAtUnixMs);
  const today = new Date();
  const sameDay =
    start.getFullYear() === end.getFullYear() &&
    start.getMonth() === end.getMonth() &&
    start.getDate() === end.getDate();
  const isToday =
    start.getFullYear() === today.getFullYear() &&
    start.getMonth() === today.getMonth() &&
    start.getDate() === today.getDate();
  const date = isToday
    ? "Today"
    : start.toLocaleDateString([], { month: "short", day: "numeric" });
  return `${date} · ${activityRangeLabel(startedAtUnixMs, endedAtUnixMs)}${
    sameDay ? "" : " · next day"
  }`;
}

export function activityTimelinePosition(
  startedAtUnixMs: number,
  endedAtUnixMs: number,
  reviewStartedAtUnixMs: number,
  reviewEndedAtUnixMs: number,
) {
  const range = Math.max(1, reviewEndedAtUnixMs - reviewStartedAtUnixMs);
  const left = Math.max(
    0,
    Math.min(100, ((startedAtUnixMs - reviewStartedAtUnixMs) / range) * 100),
  );
  const right = Math.max(
    left,
    Math.min(100, ((endedAtUnixMs - reviewStartedAtUnixMs) / range) * 100),
  );
  return { left, width: Math.max(0.8, right - left) };
}

function todayRange(now = new Date()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return {
    startedAtUnixMs: start.getTime(),
    endedAtUnixMs: now.getTime(),
  };
}

export function AgentSessionsPanel({
  client,
  workspaceLabels,
}: {
  client: WorkspaceClient;
  workspaceLabels: Record<string, { key: string; title: string }>;
}) {
  const [cachedReview] = useState(() =>
    loadActivityWatchReviewSnapshot(),
  );
  const [reviewHistory, setReviewHistory] = useState(
    loadActivityWatchReviewHistory,
  );
  const [selectedIntervalId, setSelectedIntervalId] = useState<string | null>(
    null,
  );
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [observedSessions, setObservedSessions] = useState<
    ObservedAgentSession[]
  >([]);
  const [sessionState, setSessionState] = useState<ReadState>("loading");
  const [sessionError, setSessionError] = useState("");
  const [activityStatus, setActivityStatus] =
    useState<ActivityWatchStatus | null>(null);
  const [activityState, setActivityState] = useState<ReadState>("loading");
  const [activityError, setActivityError] = useState("");
  const [review, setReview] = useState<ActivityWatchDailyReview | null>(
    cachedReview?.review ?? null,
  );
  const [reviewState, setReviewState] = useState<ReviewState>(
    cachedReview ? "ready" : "idle",
  );
  const [reviewError, setReviewError] = useState("");
  const [jiraIssues, setJiraIssues] = useState<JiraActiveIssueList | null>(
    cachedReview?.jiraIssues ?? null,
  );
  const [jiraState, setJiraState] = useState<ReviewState>(
    cachedReview ? "ready" : "idle",
  );
  const [jiraError, setJiraError] = useState("");
  const [assignments, setAssignments] = useState<Record<string, string>>(
    cachedReview?.assignments ?? {},
  );
  const [reviewBuiltAtUnixMs, setReviewBuiltAtUnixMs] = useState(
    cachedReview?.builtAtUnixMs ?? 0,
  );
  const [briefState, setBriefState] = useState<"idle" | "copied" | "error">(
    "idle",
  );
  const [ignoredApplications, setIgnoredApplications] = useState(
    loadIgnoredApplications,
  );
  const [showIgnoredApplications, setShowIgnoredApplications] = useState(false);
  const [refreshCount, setRefreshCount] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [reviewSchedule, setReviewSchedule] = useState(loadTimeReviewSchedule);
  const [notificationState, setNotificationState] =
    useState<DesktopNotificationState>(desktopNotificationState);
  const generationRef = useRef(0);
  const refreshSessions = useCallback(
    async (showLoading = false) => {
      const generation = generationRef.current;
      if (showLoading) setSessionState("loading");
      try {
        const result = await client.listAgentSessions();
        if (generation !== generationRef.current) return;
        setSessions(result.sessions);
        setObservedSessions(result.observedSessions ?? []);
        setSessionState("ready");
        setSessionError("");
        setNow(Date.now());
      } catch (error) {
        if (generation !== generationRef.current) return;
        setSessionState("error");
        setSessionError(
          error instanceof Error
            ? error.message
            : "WTS could not read agent sessions.",
        );
      }
    },
    [client],
  );

  const refreshActivityWatch = useCallback(async () => {
    const generation = generationRef.current;
    setActivityState("loading");
    try {
      const result = await client.getActivityWatchStatus();
      if (generation !== generationRef.current) return;
      setActivityStatus(result);
      setActivityState("ready");
      setActivityError("");
    } catch (error) {
      if (generation !== generationRef.current) return;
      setActivityState("error");
      setActivityError(
        error instanceof Error
          ? error.message
          : "WTS could not check ActivityWatch.",
      );
    }
  }, [client]);

  const buildDailyReview = useCallback(async (range = todayRange()) => {
    const generation = generationRef.current;
    setReviewState("loading");
    setJiraState("loading");
    setAssignments({});
    const [reviewResult, jiraResult] = await Promise.allSettled([
      client.getActivityWatchDailyReview(
        range.startedAtUnixMs,
        range.endedAtUnixMs,
      ),
      client.listActiveJiraIssues(),
    ]);
    if (generation !== generationRef.current) return;
    if (reviewResult.status === "fulfilled") {
      setReview(reviewResult.value);
      setReviewState("ready");
      setReviewError("");
    } else {
      setReviewState("error");
      setReviewError(
        reviewResult.reason instanceof Error
          ? reviewResult.reason.message
          : "WTS could not build the daily review.",
      );
    }
    if (jiraResult.status === "fulfilled") {
      setJiraIssues(jiraResult.value);
      setJiraState("ready");
      setJiraError("");
    } else {
      setJiraState("error");
      setJiraError(
        jiraResult.reason instanceof Error
          ? jiraResult.reason.message
          : "WTS could not read assigned Jira tickets.",
      );
    }
    if (
      reviewResult.status === "fulfilled" &&
      jiraResult.status === "fulfilled"
    ) {
      setSelectedIntervalId(null);
      const builtAtUnixMs = Date.now();
      setReviewBuiltAtUnixMs(builtAtUnixMs);
      const snapshotSaved = saveActivityWatchReviewSnapshot({
        schemaVersion: 1,
        dateKey: localDateKey(),
        builtAtUnixMs,
        review: reviewResult.value,
        jiraIssues: jiraResult.value,
        assignments: {},
      });
      if (snapshotSaved) {
        announceTimeReviewSnapshot();
      }
    }
  }, [client]);

  const showIntervalReview = useCallback(
    (snapshot: ActivityWatchReviewIntervalSnapshot) => {
      setSelectedIntervalId(snapshot.intervalId);
      setReview(snapshot.review);
      setReviewState("ready");
      setReviewError("");
      setJiraIssues(snapshot.jiraIssues);
      setJiraState("ready");
      setJiraError("");
      setAssignments({});
      setReviewBuiltAtUnixMs(snapshot.builtAtUnixMs);
    },
    [],
  );

  const showLatestDayReview = useCallback(() => {
    const snapshot = loadActivityWatchReviewSnapshot();
    if (!snapshot) return;
    setSelectedIntervalId(null);
    setReview(snapshot.review);
    setReviewState("ready");
    setReviewError("");
    setJiraIssues(snapshot.jiraIssues);
    setJiraState("ready");
    setJiraError("");
    setAssignments(snapshot.assignments);
    setReviewBuiltAtUnixMs(snapshot.builtAtUnixMs);
  }, []);

  const selectAdjacentSummary = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (
        !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(
          event.key,
        )
      ) {
        return;
      }
      const listbox = event.currentTarget.closest('[role="listbox"]');
      const options = Array.from(
        listbox?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') ?? [],
      );
      if (options.length === 0) return;
      event.preventDefault();
      const currentIndex = Math.max(0, options.indexOf(event.currentTarget));
      let nextIndex = currentIndex;
      if (event.key === "Home") nextIndex = 0;
      else if (event.key === "End") nextIndex = options.length - 1;
      else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        nextIndex = (currentIndex - 1 + options.length) % options.length;
      } else {
        nextIndex = (currentIndex + 1) % options.length;
      }
      options[nextIndex].focus();
      options[nextIndex].click();
    },
    [],
  );

  const updateReviewSchedule = useCallback(
    (update: Partial<Pick<
      typeof reviewSchedule,
      "enabled" | "intervalHours" | "notificationsEnabled"
    >>) => {
      const next = { ...reviewSchedule, ...update };
      saveTimeReviewSchedule(next);
      setReviewSchedule(next);
    },
    [reviewSchedule],
  );

  const enableNotifications = useCallback(async () => {
    const next = await requestDesktopNotifications();
    setNotificationState(next);
    updateReviewSchedule({ notificationsEnabled: next === "granted" });
  }, [updateReviewSchedule]);

  const ignoredSessionCount =
    review?.sessions.filter((session) =>
      isApplicationIgnored(session.application, ignoredApplications),
    ).length ?? 0;
  const visibleReview = useMemo(() => {
    if (!review) return null;
    const sessions = review.sessions.filter(
      (session) =>
        showIgnoredApplications ||
        !isApplicationIgnored(session.application, ignoredApplications),
    );
    const ignoredSeconds = review.sessions
      .filter((session) =>
        isApplicationIgnored(session.application, ignoredApplications),
      )
      .reduce((total, session) => total + session.durationSeconds, 0);
    return {
      ...review,
      sessions,
      totalActiveSeconds: showIgnoredApplications
        ? review.totalActiveSeconds
        : Math.max(0, review.totalActiveSeconds - ignoredSeconds),
    };
  }, [ignoredApplications, review, showIgnoredApplications]);
  const applicationSummary = useMemo(() => {
    const totals = new Map<string, number>();
    for (const session of visibleReview?.sessions ?? []) {
      const application = session.application ?? "Unknown application";
      totals.set(
        application,
        (totals.get(application) ?? 0) + session.durationSeconds,
      );
    }
    return [...totals.entries()]
      .map(([application, durationSeconds]) => ({
        application,
        durationSeconds,
      }))
      .sort((left, right) => right.durationSeconds - left.durationSeconds);
  }, [visibleReview]);
  const agentReview = useMemo(() => {
    if (!review) return null;
    const sessions = review.sessions.filter(
      (session) =>
        !isApplicationIgnored(session.application, ignoredApplications),
    );
    const ignoredSeconds = review.sessions
      .filter((session) =>
        isApplicationIgnored(session.application, ignoredApplications),
      )
      .reduce((total, session) => total + session.durationSeconds, 0);
    return {
      ...review,
      sessions,
      totalActiveSeconds: Math.max(
        0,
        review.totalActiveSeconds - ignoredSeconds,
      ),
    };
  }, [ignoredApplications, review]);

  const updateIgnoredApplication = useCallback(
    (application: string, ignored: boolean) => {
      setIgnoredApplications((current) => {
        const next = new Set(current);
        const normalized = application.trim().toLocaleLowerCase();
        if (ignored) next.add(normalized);
        else next.delete(normalized);
        saveIgnoredApplications(next);
        return next;
      });
    },
    [],
  );

  const copyAgentBrief = useCallback(async () => {
    if (!agentReview || !jiraIssues) return;
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard access is unavailable.");
      }
      await navigator.clipboard.writeText(
        buildTimeReviewAgentBrief(agentReview, jiraIssues),
      );
      setBriefState("copied");
    } catch {
      setBriefState("error");
    }
  }, [agentReview, jiraIssues]);

  useEffect(() => {
    if (
      selectedIntervalId !== null ||
      !review ||
      !jiraIssues ||
      reviewBuiltAtUnixMs === 0
    ) {
      return;
    }
    saveActivityWatchReviewSnapshot({
      schemaVersion: 1,
      dateKey: localDateKey(),
      builtAtUnixMs: reviewBuiltAtUnixMs,
      review,
      jiraIssues,
      assignments,
    });
  }, [
    assignments,
    jiraIssues,
    review,
    reviewBuiltAtUnixMs,
    selectedIntervalId,
  ]);

  useEffect(() => {
    const syncSchedule = () => setReviewSchedule(loadTimeReviewSchedule());
    return subscribeTimeReviewSchedule(syncSchedule);
  }, []);

  useEffect(() => {
    const syncSnapshot = () => {
      const history = loadActivityWatchReviewHistory();
      setReviewHistory(history);
      if (selectedIntervalId !== null) {
        const selected = history.find(
          (snapshot) => snapshot.intervalId === selectedIntervalId,
        );
        if (selected) {
          showIntervalReview(selected);
          return;
        }
      }
      const snapshot = loadActivityWatchReviewSnapshot();
      if (!snapshot) return;
      setReview(snapshot.review);
      setReviewState("ready");
      setReviewError("");
      setJiraIssues(snapshot.jiraIssues);
      setJiraState("ready");
      setJiraError("");
      setAssignments(snapshot.assignments);
      setReviewBuiltAtUnixMs(snapshot.builtAtUnixMs);
    };
    return subscribeTimeReviewSnapshot(syncSnapshot);
  }, [selectedIntervalId, showIntervalReview]);

  useEffect(() => {
    generationRef.current += 1;
    setRefreshCount(0);
    void refreshSessions(true);
    void refreshActivityWatch();
    return () => {
      generationRef.current += 1;
    };
  }, [refreshActivityWatch, refreshSessions]);

  useEffect(() => {
    if (
      sessionState === "error" ||
      refreshCount >= MAX_AUTOMATIC_REFRESHES
    ) {
      return;
    }
    const timeout = window.setTimeout(() => {
      setRefreshCount((count) => count + 1);
      void refreshSessions(false);
    }, REFRESH_INTERVAL_MS);
    return () => window.clearTimeout(timeout);
  }, [refreshCount, refreshSessions, sessionState]);

  const orderedSessions = useMemo(
    () =>
      [...sessions].sort(
        (left, right) =>
          Number(right.status === "running") -
            Number(left.status === "running") ||
          right.startedAtUnixMs - left.startedAtUnixMs,
      ),
    [sessions],
  );
  const openRecordCount = sessions.filter(
    (session) => session.status === "running",
  ).length + observedSessions.filter((session) => session.status === "working").length;
  const automaticRefreshPaused =
    refreshCount >= MAX_AUTOMATIC_REFRESHES;
  return (
    <section
      aria-labelledby="agent-sessions-title"
      className={styles.panel}
      data-ui="activity.panel"
      data-ui-label="Work activity panel"
    >
      <header
        className={styles.header}
        data-ui="activity.header"
        data-ui-label="Work activity header"
      >
        <h2 id="agent-sessions-title">Work activity</h2>
      </header>

      <Tabs.Root className={styles.tabs} defaultValue="activity-review">
        <Tabs.List
          aria-label="Work activity views"
          className={styles.tabList}
          data-ui="activity.tabs"
          data-ui-label="Work activity tabs"
        >
          <Tabs.Trigger className={styles.tab} value="activity-review">
            Activity review
          </Tabs.Trigger>
          <Tabs.Trigger className={styles.tab} value="agent-activity">
            Agent activity
            {openRecordCount > 0 && (
              <span className={styles.tabCount}>{openRecordCount}</span>
            )}
          </Tabs.Trigger>
        </Tabs.List>

        <Tabs.Content className={styles.tabPanel} value="activity-review">
          <aside
            aria-atomic="true"
            aria-busy={activityState === "loading" || undefined}
            aria-label="ActivityWatch connection status"
            aria-live="polite"
            className={styles.activityWatch}
            data-ui="activity.connection"
            data-ui-label="Activity connection"
            data-state={activityStatus?.state}
            role="status"
          >
            <span className={styles.activityDot} aria-hidden="true" />
            <div>
              <strong>
                ActivityWatch · {activityState === "loading"
                  ? "WTS checks the connection…"
                  : activityState === "error"
                    ? "Unavailable"
                    : activityWatchLabel(activityStatus)}
              </strong>
              {activityState === "error" && <p>{activityError}</p>}
            </div>
            <button
              disabled={activityState === "loading"}
              onClick={() => void refreshActivityWatch()}
              type="button"
            >
              {activityState === "loading"
                ? "WTS checks…"
                : "Check connection"}
            </button>
          </aside>

          <section
            aria-busy={reviewState === "loading" || undefined}
            aria-labelledby="daily-review-title"
            className={styles.dailyReview}
            data-ui="activity.daily-review"
            data-ui-label="Daily activity review"
          >
            <header>
              <div className={styles.reviewHeading}>
                <h3 id="daily-review-title">My time</h3>
                <span>
                  {reviewSchedule.enabled
                    ? `WTS summarizes work every ${reviewSchedule.intervalHours} hours.`
                    : "Automatic summaries are off."}
                </span>
              </div>
              <div className={styles.reviewActions}>
                <label className={styles.scheduleControl}>
                  <span>Summary</span>
                  <select
                    aria-label="Automatic summary interval"
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      if (value === 0) {
                        updateReviewSchedule({ enabled: false });
                        return;
                      }
                      updateReviewSchedule({
                        enabled: true,
                        intervalHours: value as TimeReviewIntervalHours,
                      });
                    }}
                    value={reviewSchedule.enabled ? reviewSchedule.intervalHours : 0}
                  >
                    <option value={0}>Manual</option>
                    {timeReviewIntervals.map((hours) => (
                      <option key={hours} value={hours}>
                        Every {hours} hours
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  aria-pressed={reviewSchedule.notificationsEnabled}
                  disabled={notificationState === "unsupported"}
                  onClick={() => {
                    if (reviewSchedule.notificationsEnabled) {
                      updateReviewSchedule({ notificationsEnabled: false });
                    } else {
                      void enableNotifications();
                    }
                  }}
                  type="button"
                >
                  {notificationState === "unsupported"
                    ? "Notifications unavailable"
                    : notificationState === "denied"
                      ? "Notifications blocked"
                      : reviewSchedule.notificationsEnabled
                        ? "Notifications on"
                        : "Enable notifications"}
                </button>
                {review && jiraIssues && (
                  <button onClick={() => void copyAgentBrief()} type="button">
                    {briefState === "copied"
                      ? "Agent brief copied"
                      : briefState === "error"
                        ? "Copy failed"
                        : "Copy agent brief"}
                  </button>
                )}
                <button
                  disabled={
                    reviewState === "loading" ||
                    activityStatus?.state !== "running"
                  }
                  onClick={() => void buildDailyReview()}
                  type="button"
                >
                  {reviewState === "loading"
                      ? "WTS builds…"
                      : reviewState === "ready"
                        ? "Refresh"
                        : "Build today’s review"}
                </button>
              </div>
            </header>
            {reviewHistory.length > 0 && (
              <div
                className={styles.reviewHistory}
                data-ui="activity.summary-history"
                data-ui-label="Activity summary history"
              >
                <div className={styles.reviewHistoryHeading}>
                  <strong>Recent summaries</strong>
                  <span>{reviewHistory.length} saved</span>
                </div>
                <div
                  aria-label="Recent automatic summaries"
                  className={styles.reviewHistoryList}
                  role="listbox"
                >
                  <button
                    aria-selected={selectedIntervalId === null}
                    onClick={showLatestDayReview}
                    onKeyDown={selectAdjacentSummary}
                    role="option"
                    tabIndex={selectedIntervalId === null ? 0 : -1}
                    type="button"
                  >
                    <strong>Today</strong>
                    <span>Latest day review</span>
                  </button>
                  {reviewHistory.map((snapshot) => (
                    <button
                      aria-selected={
                        selectedIntervalId === snapshot.intervalId
                      }
                      key={snapshot.intervalId}
                      onClick={() => showIntervalReview(snapshot)}
                      onKeyDown={selectAdjacentSummary}
                      role="option"
                      tabIndex={
                        selectedIntervalId === snapshot.intervalId ? 0 : -1
                      }
                      type="button"
                    >
                      <strong>
                        {intervalDateLabel(
                          snapshot.startedAtUnixMs,
                          snapshot.endedAtUnixMs,
                        )}
                      </strong>
                      <span>
                        {compactDuration(snapshot.review.totalActiveSeconds)} ·{" "}
                        {snapshot.review.sessions.length}{" "}
                        {snapshot.review.sessions.length === 1
                          ? "block"
                          : "blocks"}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            <span
              aria-atomic="true"
              aria-live="polite"
              className={styles.srOnly}
              role="status"
            >
              {briefState === "copied"
                ? "Agent brief copied to clipboard."
                : briefState === "error"
                  ? "Agent brief could not be copied."
                  : ""}
            </span>
            {reviewState === "loading" && (
              <div
                aria-live="polite"
                className={styles.reviewState}
                role="status"
              >
                <strong>WTS builds today’s review…</strong>
              </div>
            )}
        {reviewState === "idle" && (
          <div className={styles.reviewState}>
            <strong>No activity yet.</strong>
          </div>
        )}
        {reviewState === "error" && (
          <div className={styles.reviewState} data-error role="alert">
            <strong>Daily review could not be built.</strong>
            <span>{reviewError}</span>
          </div>
        )}
        {reviewState === "ready" && review && (
          <>
            <div className={styles.reviewSummary} aria-live="polite">
              <strong>{compactDuration(visibleReview?.totalActiveSeconds ?? 0)}</strong>
              <span>
                {visibleReview?.sessions.length ?? 0}{" "}
                {(visibleReview?.sessions.length ?? 0) === 1 ? "block" : "blocks"}
              </span>
              {ignoredSessionCount > 0 && (
                <button
                  className={styles.ignoredToggle}
                  onClick={() =>
                    setShowIgnoredApplications((current) => !current)
                  }
                  type="button"
                >
                  {showIgnoredApplications
                    ? "Hide ignored"
                    : `${ignoredSessionCount} ignored`}
                </button>
              )}
            </div>
            {(visibleReview?.sessions.length ?? 0) > 0 && (
              <section
                aria-label="Activity overview"
                className={styles.activityOverview}
                data-ui="activity.overview"
                data-ui-label="Activity overview"
              >
                <div className={styles.applicationBreakdown}>
                  <div className={styles.overviewHeading}>
                    <strong>Applications</strong>
                    <span>Active time</span>
                  </div>
                  <ol aria-label="Application activity totals">
                    {applicationSummary.map((application) => (
                      <li key={application.application}>
                        <span
                          aria-hidden="true"
                          className={styles.applicationMark}
                        />
                        <strong>{application.application}</strong>
                        <span>{compactDuration(application.durationSeconds)}</span>
                      </li>
                    ))}
                  </ol>
                </div>
                <div className={styles.activityTimeline}>
                  <div className={styles.overviewHeading}>
                    <strong>Activity blocks</strong>
                    <span>
                      {activityRangeLabel(
                        visibleReview!.startedAtUnixMs,
                        visibleReview!.endedAtUnixMs,
                      )}
                    </span>
                  </div>
                  <ol aria-label="Daily activity timeline">
                    {visibleReview?.sessions.map((session) => {
                      const position = activityTimelinePosition(
                        session.startedAtUnixMs,
                        session.endedAtUnixMs,
                        visibleReview.startedAtUnixMs,
                        visibleReview.endedAtUnixMs,
                      );
                      return (
                        <li key={session.id}>
                          <span className={styles.timelineLabel}>
                            <span>
                              {activityRangeLabel(
                                session.startedAtUnixMs,
                                session.endedAtUnixMs,
                              )}
                            </span>
                          </span>
                          <span className={styles.timelineTrack}>
                            <span
                              aria-label={`${session.application ?? "Unknown application"}, ${compactDuration(session.durationSeconds)}`}
                              className={styles.timelineBlock}
                              data-kind={session.kind}
                              role="img"
                              style={
                                {
                                  "--activity-left": `${position.left}%`,
                                  "--activity-width": `${position.width}%`,
                                } as CSSProperties
                              }
                            />
                          </span>
                        </li>
                      );
                    })}
                  </ol>
                </div>
              </section>
            )}
            {jiraState !== "ready" && (
              <div
                aria-atomic="true"
                aria-busy={jiraState === "loading" || undefined}
                aria-live="polite"
                className={styles.jiraContext}
                data-state={jiraState}
                role="status"
              >
                <strong>
                  {jiraState === "loading"
                    ? "WTS loads Jira tickets…"
                    : "Jira tickets are unavailable"}
                </strong>
                {jiraState === "error" && <span>{jiraError}</span>}
              </div>
            )}
            {(visibleReview?.sessions.length ?? 0) === 0 ? (
              <div className={styles.reviewState}>
                <strong>
                  {ignoredSessionCount > 0
                    ? "All current activity is ignored."
                    : "No active work found for today."}
                </strong>
                {ignoredSessionCount > 0 && (
                  <span>
                    Review ignored applications to include a block again.
                  </span>
                )}
              </div>
            ) : (
              <ol
                aria-label="Today’s ActivityWatch review"
                className={styles.reviewList}
                data-ui="activity.review-list"
                data-ui-label="Daily activity list"
              >
                {visibleReview?.sessions.map((session) => {
                  const applicationIgnored = isApplicationIgnored(
                    session.application,
                    ignoredApplications,
                  );
                  const suggestions = suggestJiraIssues(
                    session,
                    jiraIssues?.issues ?? [],
                  );
                  const selectedKey =
                    assignments[session.id] ??
                    suggestions[0]?.issueKey ??
                    "";
                  const selectedIssue = jiraIssues?.issues.find(
                    (issue) => issue.issueKey === selectedKey,
                  );
                  const selectedSuggestion = suggestions.find(
                    (suggestion) => suggestion.issueKey === selectedKey,
                  );
                  return (
                    <li key={session.id}>
                      <div className={styles.reviewIdentity}>
                        <strong>
                          {session.activityEvidence ?? session.description}
                        </strong>
                        <span className={styles.activitySource}>
                          <span>
                            {session.application ?? "Unknown application"} ·{" "}
                            <span className={styles.activityKind}>
                              {session.kind}
                            </span>
                          </span>
                          {session.application && (
                            <>
                              {" · "}
                              <button
                                aria-label={`${
                                  applicationIgnored ? "Include" : "Ignore"
                                } activity from ${session.application}`}
                                onClick={() =>
                                  updateIgnoredApplication(
                                    session.application!,
                                    !applicationIgnored,
                                  )
                                }
                                type="button"
                              >
                                {applicationIgnored
                                  ? "Include application"
                                  : "Ignore application"}
                              </button>
                            </>
                          )}
                        </span>
                      </div>
                      <time
                        dateTime={new Date(
                          session.startedAtUnixMs,
                        ).toISOString()}
                      >
                        {new Date(session.startedAtUnixMs).toLocaleTimeString(
                          [],
                          { hour: "2-digit", minute: "2-digit" },
                        )}
                      </time>
                      <strong>{compactDuration(session.durationSeconds)}</strong>
                      <label className={styles.assignment}>
                        <span>
                          Jira
                          {selectedSuggestion
                            ? ` · ${selectedSuggestion.confidence}% match`
                            : ""}
                        </span>
                        <select
                          aria-label={`Jira ticket for ${
                            session.activityEvidence ?? session.description
                          }`}
                          disabled={jiraState !== "ready"}
                          onChange={(event) =>
                            setAssignments((current) => ({
                              ...current,
                              [session.id]: event.target.value,
                            }))
                          }
                          value={selectedKey}
                        >
                          <option value="">Unassigned</option>
                          {(jiraIssues?.issues ?? []).map((issue) => (
                            <option key={issue.issueKey} value={issue.issueKey}>
                              {issue.issueKey} · {issue.summary}
                            </option>
                          ))}
                        </select>
                        {(selectedSuggestion || selectedIssue) && (
                          <small>
                            {selectedSuggestion?.reason ?? selectedIssue?.status}
                          </small>
                        )}
                      </label>
                    </li>
                  );
                })}
              </ol>
            )}
          </>
        )}
          </section>
        </Tabs.Content>

        <Tabs.Content className={styles.tabPanel} value="agent-activity">
          <div
            className={styles.listHeader}
            data-ui="activity.agent-sessions-header"
            data-ui-label="Agent sessions header"
          >
            <div>
              <small>WORKSPACE AGENT SESSIONS</small>
              <h3>Agent sessions</h3>
            </div>
            <span aria-live="polite">
              {openRecordCount} open ·{" "}
              {automaticRefreshPaused
                ? "refresh paused"
                : "refreshes every 5 seconds"}
            </span>
          </div>

          <div aria-busy={sessionState === "loading" || undefined}>
            {sessionState === "loading" && (
              <div className={styles.state} role="status">
                <span className={styles.loader} aria-hidden="true" />
                WTS reads managed sessions…
              </div>
            )}
            {sessionState === "error" && (
              <div className={styles.state} data-error role="alert">
                <strong>Session history could not be loaded.</strong>
                <span>{sessionError}</span>
                <button onClick={() => void refreshSessions(true)} type="button">
                  Try again
                </button>
              </div>
            )}
            {sessionState === "ready" && orderedSessions.length === 0 && observedSessions.length === 0 && (
              <div className={styles.state}>
                <strong>No agent sessions are visible.</strong>
                <span>
                  Start a WTS background task or open Codex in a saved VS Code
                  workspace. The session will appear here.
                </span>
              </div>
            )}
            {sessionState === "ready" && (orderedSessions.length > 0 || observedSessions.length > 0) && (
              <ol
                aria-label="Current and recent agent sessions"
                className={styles.list}
                data-ui="activity.agent-sessions-list"
                data-ui-label="Agent sessions list"
              >
          {observedSessions.map((session) => {
            const workspace = workspaceLabels[session.workspaceId];
            const provider = session.provider === "copilot" ? "GitHub Copilot" : "Codex";
            return (
              <li key={`observed-${session.sessionId}`}>
                <span
                  aria-label={session.status === "working" ? `${provider} is working` : `${provider} is open in VS Code`}
                  className={styles.statusDot}
                  data-status={session.status === "working" ? "running" : session.status}
                />
                <div className={styles.sessionIdentity}>
                  <strong>{provider}</strong>
                  <span>VS Code · {session.model ?? "Provider-selected model"}</span>
                </div>
                <div className={styles.workspaceIdentity}>
                  <strong>{workspace?.key ?? "Unassigned workspace"}</strong>
                  <span>{workspace?.title ?? `No saved workspace matches ${session.workspaceId}`}</span>
                </div>
                <div className={styles.sessionTiming}>
                  <strong>{session.activity ? session.activity.replace(/([A-Z])/g, " $1").toLowerCase() : "No activity detail"}</strong>
                  <time dateTime={new Date(session.lastEventAtUnixMs).toISOString()}>
                    {new Date(session.lastEventAtUnixMs).toLocaleString()}
                  </time>
                </div>
                <span className={styles.status} data-status={session.status === "working" ? "running" : session.status}>
                  {session.status === "working" ? "Working in VS Code" : "Open in VS Code"}
                </span>
              </li>
            );
          })}
          {orderedSessions.map((session) => {
            const failure = failureLabel(session.failure);
            const workspace = workspaceLabels[session.workspaceId];
            return (
              <li key={session.sessionId}>
                <span
                  aria-label={statusLabels[session.status]}
                  className={styles.statusDot}
                  data-status={session.status}
                />
                <div className={styles.sessionIdentity}>
                  <strong>{providerLabels[session.provider]}</strong>
                  <span>
                    {session.terminal === "warp" ? "Warp" : "Terminal"} ·{" "}
                    {categoryLabel(session.category)}
                  </span>
                </div>
                <div className={styles.workspaceIdentity}>
                  <strong>{workspace?.key ?? "Unassigned workspace"}</strong>
                  <span>
                    {workspace?.title ??
                      `No saved workspace matches ${session.workspaceId}`}
                  </span>
                </div>
                <div className={styles.sessionTiming}>
                  <strong>{durationLabel(session, now)}</strong>
                  <time dateTime={new Date(session.startedAtUnixMs).toISOString()}>
                    {new Date(session.startedAtUnixMs).toLocaleString()}
                  </time>
                </div>
                <span
                  className={styles.status}
                  data-status={session.status}
                  title={failure ?? undefined}
                >
                  {failure ?? statusLabels[session.status]}
                </span>
              </li>
            );
          })}
              </ol>
            )}
          </div>
        </Tabs.Content>
      </Tabs.Root>
    </section>
  );
}
