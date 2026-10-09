import { subscribeAppRefresh } from "../../lib/appRefresh";
import { loadActivityReviewRange } from "../../lib/activityReviewRange";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CSSProperties } from "react";
import type {
  ActivityWatchDailyReview,
  ActivityWatchStatus,
  AgentProvider,
  AgentSession,
  AgentSessionStatus,
  JiraActiveIssueList,
  ObservedAgentSession,
  UnassignedAgentWork,
  WorkspaceClient,
} from "../../lib/wtsClient";
import {
  loadActivityWatchReviewHistory,
  loadActivityWatchReviewSnapshot,
  loadFinishedDayReview,
  localDateKey,
  saveActivityWatchReviewSnapshot,
  saveFinishedDayReview,
  type ActivityWatchReviewIntervalSnapshot,
} from "./activityWatchReviewCache";
import {
  isApplicationIgnored,
  loadIgnoredApplications,
  saveIgnoredApplications,
} from "./activityWatchIgnoredApplications";
import { suggestJiraIssues } from "./activityWatchSuggestions";
import { groupUnassignedWork } from "./jiraWorkGroups";
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
import { SelectMenu } from "../../components/SelectMenu";
import { loadAgentSessions } from "../../lib/agentSessionDiscovery";
import { InfoTooltip } from "./InfoTooltip";
import { Glyph } from "./Glyph";
import {
  agentBlocksInRange,
  type AgentTimeBlock,
  formatDuration,
  groupBlocks,
  mergeSpans,
  spanTotal,
  summarizeHybridTime,
  buildHybridTimeExport,
  topByDuration,
  timelineWindow,
  userBlocksInRange,
} from "./hybridTime";

const REFRESH_INTERVAL_MS = 5_000;
const MAX_AUTOMATIC_REFRESHES = 120;
/** Today's review older than this is rebuilt from ActivityWatch. */
export const TODAY_REVIEW_MAX_AGE_MS = 5 * 60_000;

type ReadState = "loading" | "ready" | "error";
type ReviewState = "idle" | ReadState;

const providerLabels: Record<AgentProvider, string> = {
  codex: "Codex",
  openCode: "OpenCode",
  hermes: "Hermes",
  copilot: "Copilot",
};

const statusLabels: Record<AgentSessionStatus, string> = {
  launching: "Terminal launch pending",
  handoffAccepted: "Terminal handoff accepted",
  running: "Agent active",
  stopping: "Stopping the agent…",
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

function pluralize(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Time with at least one agent at work. Parallel chats count one time. */
export function agentClockMs(blocks: readonly AgentTimeBlock[]) {
  return spanTotal(mergeSpans(blocks));
}

/** A workspace name. The key shows only when it adds information. */
export function workspaceDisplayName(workspace: { key: string; title: string }) {
  const key = workspace.key.trim();
  const title = workspace.title.trim();
  if (!key || key.toLowerCase() === title.toLowerCase()) return title || key;
  if (!title) return key;
  return `${key} · ${title}`;
}

/** Counts chats, names where they ran, and gives the clock time, so the total is easy to check. */
export function agentTimeDetail(blocks: readonly AgentTimeBlock[]) {
  const chatId = (block: AgentTimeBlock) => (block.source === "terminal" ? block.id : block.id.slice(0, block.id.lastIndexOf(":")));
  const chats = new Set(blocks.map(chatId)).size;
  const outside = new Set(blocks.filter((block) => block.source === "outsideWorkspace").map(chatId)).size;
  const where = outside === 0
    ? ""
    : outside === chats
      ? ` outside saved workspaces`
      : ` · ${outside} outside saved workspaces`;
  const clock = formatDuration(agentClockMs(blocks));
  return chats > 1
    ? `${clock} on the clock · ${pluralize(chats, "chat")}${where}. Chats that run at the same time each add their time.`
    : `${clock} on the clock · ${pluralize(chats, "chat")}${where}.`;
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

const DAY_CHOICES = 7;
const DAY_SELECTION_PREFIX = "day:";

/** Today first, then the six days before it. Each covers local midnight to midnight. */
export function recentDayChoices(now = new Date()) {
  return Array.from({ length: DAY_CHOICES }, (_, offset) => {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - offset);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    const date = start.toLocaleDateString([], { day: "numeric", month: "short" });
    return {
      id: DAY_SELECTION_PREFIX + localDateKey(start),
      offset,
      label: offset === 0 ? "Today" : offset === 1 ? "Yesterday" : start.toLocaleDateString([], { weekday: "short" }),
      detail: date,
      startedAtUnixMs: start.getTime(),
      endedAtUnixMs: offset === 0 ? now.getTime() : end.getTime(),
    };
  });
}

export function AgentSessionsPanel({
  client,
  workspaceLabels,
  onOpenIntegrations,
}: {
  client: WorkspaceClient;
  workspaceLabels: Record<string, { key: string; title: string }>;
  onOpenIntegrations?: () => void;
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
  const [showPeriods, setShowPeriods] = useState(false);
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [observedSessions, setObservedSessions] = useState<
    ObservedAgentSession[]
  >([]);
  const [unassignedWork, setUnassignedWork] = useState<UnassignedAgentWork[]>([]);
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
  const sessionRequestRef = useRef<{ generation: number; promise: Promise<void> } | null>(null);
  const refreshSessions = useCallback(
    (showLoading = false, force = false): Promise<void> => {
      const generation = generationRef.current;
      if (showLoading) setSessionState("loading");
      if (sessionRequestRef.current?.generation === generation) {
        return sessionRequestRef.current.promise;
      }
      const request: Promise<void> = Promise.resolve().then(async () => {
        try {
          const result = await loadAgentSessions(client, undefined, { force });
          if (generation !== generationRef.current) return;
          setSessions(result.sessions);
          setObservedSessions(result.observedSessions ?? []);
          setUnassignedWork(result.unassignedWork ?? []);
          setSessionState("ready");
          setSessionError("");
          setNow(Date.now());
        } catch (error) {
          if (generation !== generationRef.current) return;
          setSessionState("error");
          setSessionError(
            error instanceof Error
              ? error.message
              : "Could not read agent sessions.",
          );
        } finally {
          if (sessionRequestRef.current?.promise === request) {
            sessionRequestRef.current = null;
          }
        }
      });
      sessionRequestRef.current = { generation, promise: request };
      return request;
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
          : "Could not check ActivityWatch.",
      );
    }
  }, [client]);

  const buildDailyReview = useCallback(async (range = todayRange()) => {
    const generation = generationRef.current;
    setReviewState("loading");
    // Keep a loaded Jira list visible while it reloads.
    setJiraState((current) => (current === "ready" ? "ready" : "loading"));
    setReviewError("");
    setJiraError("");
    setBriefState("idle");
    // Jira can take many seconds. Show the time review as soon as ActivityWatch answers.
    const jiraRequest = client.listActiveJiraIssues();
    jiraRequest.catch(() => undefined);
    const [reviewResult] = await Promise.allSettled([
      loadActivityReviewRange(client,
        range.startedAtUnixMs,
        range.endedAtUnixMs,
      ),
    ]);
    if (generation !== generationRef.current) return;
    if (reviewResult.status === "fulfilled") {
      setSelectedIntervalId(null);
      setReviewBuiltAtUnixMs(Date.now());
      setReview(reviewResult.value);
      setReviewState("ready");
      setReviewError("");
      setAssignments((current) => Object.fromEntries(Object.entries(current).filter(([id]) => reviewResult.value.sessions.some((session) => session.id === id))));
    } else {
      setReviewState(review ? "ready" : "error");
      setReviewError(
        reviewResult.reason instanceof Error
          ? reviewResult.reason.message
          : "Could not build the daily review.",
      );
    }
    const [jiraResult] = await Promise.allSettled([jiraRequest]);
    if (generation !== generationRef.current) return;
    if (jiraResult.status === "fulfilled") {
      setJiraIssues(jiraResult.value);
      setJiraState("ready");
      setJiraError("");
    } else {
      setJiraState("error");
      setJiraError(
        jiraResult.reason instanceof Error
          ? jiraResult.reason.message
          : "Could not read assigned Jira tickets.",
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
        assignments: Object.fromEntries(Object.entries(assignments).filter(([id]) => reviewResult.value.sessions.some((session) => session.id === id))),
      });
      if (snapshotSaved) {
        announceTimeReviewSnapshot();
      }
    }
  }, [assignments, client, review]);

  const retryJiraIssues = useCallback(async () => {
    const generation = generationRef.current;
    setJiraState("loading");
    try {
      const issues = await client.listActiveJiraIssues();
      if (generation !== generationRef.current) return;
      setJiraIssues(issues);
      setJiraState("ready");
      setJiraError("");
    } catch (error) {
      if (generation !== generationRef.current) return;
      setJiraState("error");
      setJiraError(error instanceof Error ? error.message : "Could not read assigned Jira tickets.");
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
    generationRef.current += 1;
    setSelectedIntervalId(null);
    if (!snapshot || Date.now() - snapshot.builtAtUnixMs > TODAY_REVIEW_MAX_AGE_MS) {
      void buildDailyReview();
      if (!snapshot) return;
    }
    setReview(snapshot.review);
    setReviewState("ready");
    setReviewError("");
    setJiraIssues(snapshot.jiraIssues);
    setJiraState("ready");
    setJiraError("");
    setAssignments(snapshot.assignments);
    setReviewBuiltAtUnixMs(snapshot.builtAtUnixMs);
  }, [buildDailyReview]);

  /**
   * Shows one earlier day. A finished day cannot change, so a cached day shows at once
   * and ActivityWatch is read only on the first visit. It does not replace today's saved review.
   */
  const showPastDay = useCallback(
    async (day: { id: string; startedAtUnixMs: number; endedAtUnixMs: number }) => {
      generationRef.current += 1;
      const generation = generationRef.current;
      setSelectedIntervalId(day.id);
      setReviewError("");
      setAssignments({});
      if (!jiraIssues) {
        setJiraState("loading");
        client.listActiveJiraIssues().then(
          (issues) => {
            setJiraIssues(issues);
            setJiraState("ready");
          },
          () => setJiraState("error"),
        );
      }
      const cached = loadFinishedDayReview(day.startedAtUnixMs, day.endedAtUnixMs);
      if (cached) {
        setReview(cached);
        setReviewState("ready");
        setReviewBuiltAtUnixMs(Date.now());
        return;
      }
      setReviewState("loading");
      try {
        const dayReview = await loadActivityReviewRange(client, day.startedAtUnixMs, day.endedAtUnixMs);
        saveFinishedDayReview(dayReview);
        if (generation !== generationRef.current) return;
        setReview(dayReview);
        setReviewState("ready");
        setReviewBuiltAtUnixMs(Date.now());
      } catch (error) {
        if (generation !== generationRef.current) return;
        setReviewState("error");
        setReview(null);
        setReviewError(error instanceof Error ? error.message : "Could not read this day from ActivityWatch.");
      }
    },
    [client, jiraIssues],
  );

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
      // A past day stays on screen until the user picks another day.
      if (selectedIntervalId?.startsWith(DAY_SELECTION_PREFIX)) return;
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

  const initializedDayRef = useRef<string | null>(null);
  useEffect(() => {
    const day = localDateKey();
    if (activityStatus?.state !== "running" || initializedDayRef.current === day) return;
    initializedDayRef.current = day;
    const stale = Date.now() - reviewBuiltAtUnixMs > TODAY_REVIEW_MAX_AGE_MS;
    if (!review || review.startedAtUnixMs !== todayRange().startedAtUnixMs || stale) void buildDailyReview();
  }, [activityStatus, review, reviewBuiltAtUnixMs, buildDailyReview]);

  // Keep Today current while it is on screen. A saved period or past day stays as is.
  const buildDailyReviewRef = useRef(buildDailyReview);
  buildDailyReviewRef.current = buildDailyReview;
  const reviewBusyRef = useRef(false);
  reviewBusyRef.current = reviewState === "loading";
  useEffect(() => {
    if (activityStatus?.state !== "running" || selectedIntervalId !== null) return;
    const timer = window.setInterval(() => {
      if (reviewBusyRef.current) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void buildDailyReviewRef.current();
    }, TODAY_REVIEW_MAX_AGE_MS);
    return () => window.clearInterval(timer);
  }, [activityStatus?.state, selectedIntervalId]);

  useEffect(() => subscribeAppRefresh(client, () => {
    setRefreshCount(0);
    void refreshSessions(false, true);
    void refreshActivityWatch();
    void buildDailyReview();
  }), [client, refreshSessions, refreshActivityWatch, buildDailyReview]);

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
  ).length + observedSessions.filter((session) => session.status === "working").length
    + unassignedWork.filter((work) => work.working).length;
  const automaticRefreshPaused =
    refreshCount >= MAX_AUTOMATIC_REFRESHES;
  const hybrid = useMemo(() => {
    const dayStart = todayRange(new Date(now)).startedAtUnixMs;
    const range =
      selectedIntervalId !== null && review
        ? { startedAtUnixMs: review.startedAtUnixMs, endedAtUnixMs: review.endedAtUnixMs }
        : {
            startedAtUnixMs: review ? Math.min(review.startedAtUnixMs, dayStart) : dayStart,
            endedAtUnixMs: Math.max(now, review?.endedAtUnixMs ?? 0),
          };
    const userBlocks = userBlocksInRange(visibleReview?.sessions ?? [], range);
    const agentBlocks = agentBlocksInRange(sessions, observedSessions, range, now, unassignedWork);
    const summary = summarizeHybridTime(
      userBlocks,
      agentBlocks,
      visibleReview ? visibleReview.totalActiveSeconds * 1_000 : 0,
    );
    const window = timelineWindow([...userBlocks, ...agentBlocks], range, now);
    return { range, summary, window };
  }, [now, observedSessions, review, selectedIntervalId, sessions, unassignedWork, visibleReview]);
  const agentWorkBySession = useMemo(() => {
    const totals = new Map<string, number>();
    for (const block of hybrid.summary.agentBlocks) {
      const id = block.source === "terminal" ? block.id : block.id.slice(0, block.id.lastIndexOf(":"));
      totals.set(id, (totals.get(id) ?? 0) + block.durationMs);
    }
    return totals;
  }, [hybrid.summary.agentBlocks]);
  const [showAllSessions, setShowAllSessions] = useState(false);
  const [expandedBlocks, setExpandedBlocks] = useState<ReadonlySet<string>>(() => new Set());
  const [dismissedGroups, setDismissedGroups] = useState<ReadonlySet<string>>(() => new Set());
  const workGroups = useMemo(
    () =>
      jiraState === "ready"
        ? groupUnassignedWork(visibleReview?.sessions ?? [], jiraIssues?.issues ?? [], assignments)
            .filter((group) => !dismissedGroups.has(group.issueKey))
        : [],
    [assignments, dismissedGroups, jiraIssues, jiraState, visibleReview],
  );
  const assignGroup = (sessionIds: readonly string[], issueKey: string) =>
    setAssignments((current) => ({ ...current, ...Object.fromEntries(sessionIds.map((id) => [id, issueKey])) }));
  const toggleBlock = useCallback((id: string) => {
    setExpandedBlocks((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const connectionLabel =
    activityState === "loading"
      ? "Checking the connection…"
      : activityState === "error"
        ? "Unavailable"
        : activityWatchLabel(activityStatus);
  const activityConnected = activityState === "ready" && activityStatus?.state === "running";
  const activityProblem = activityState !== "loading" && !activityConnected;
  // Keep the last review on screen while a refresh reads ActivityWatch again.
  const reviewReady = Boolean(review) && (reviewState === "ready" || reviewState === "loading");
  const reviewShown = reviewReady;
  const summary = hybrid.summary;
  const roundMinutes = (ms: number) => Math.round(ms / 60_000) * 60_000;
  const shownUserMs = roundMinutes(summary.userMs);
  const shownAgentMs = roundMinutes(summary.agentMs);
  const windowSpan = hybrid.window;
  const ticks = useMemo(() => {
    const result: number[] = [];
    const hours = (windowSpan.endedAtUnixMs - windowSpan.startedAtUnixMs) / 3_600_000;
    const step = hours > 16 ? 3 : hours > 8 ? 2 : 1;
    for (let tick = windowSpan.startedAtUnixMs; tick <= windowSpan.endedAtUnixMs; tick += step * 3_600_000) {
      result.push(tick);
    }
    return result;
  }, [windowSpan]);
  const groupGapMs = (windowSpan.endedAtUnixMs - windowSpan.startedAtUnixMs) * 0.012;
  const userGroups = groupBlocks(summary.userBlocks, groupGapMs);
  const agentGroups = groupBlocks(summary.agentBlocks, groupGapMs);
  const overlapGroups = groupBlocks(
    summary.overlaps.map((span) => ({ ...span, id: String(span.startedAtUnixMs), durationMs: span.endedAtUnixMs - span.startedAtUnixMs })),
    groupGapMs,
  );
  const place = (start: number, end: number) =>
    activityTimelinePosition(start, end, windowSpan.startedAtUnixMs, windowSpan.endedAtUnixMs);
  const nowPosition =
    now >= windowSpan.startedAtUnixMs && now <= windowSpan.endedAtUnixMs
      ? place(now, now).left
      : null;
  const visibleSessionLimit = 6;
  const sessionRows = [
    ...observedSessions.map((session) => ({ kind: "observed" as const, session })),
    ...orderedSessions.map((session) => ({ kind: "managed" as const, session })),
  ];
  const shownSessionRows = showAllSessions ? sessionRows : sessionRows.slice(0, visibleSessionLimit);
  const workingAgentCount = openRecordCount;
  const dayChoices = recentDayChoices(new Date(now));
  const selectedDay = dayChoices.find((day) => day.id === selectedIntervalId);
  const periodsOpen = showPeriods || (selectedIntervalId !== null && !selectedDay);
  const periodLabel =
    selectedDay
      ? `${selectedDay.label} · ${selectedDay.detail}`
      : selectedIntervalId !== null && review
        ? intervalDateLabel(review.startedAtUnixMs, review.endedAtUnixMs)
        : "Today";

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
        <div className={styles.titleBlock}>
          <h2 id="agent-sessions-title">My time</h2>
          <p>Your active time and agent work, side by side.</p>
          <div className={styles.settingsRow} data-ui="activity.settings" data-ui-label="Summary settings">
            <label className={styles.scheduleControl}>
              <span>Summary</span>
              <SelectMenu
                aria-label="Automatic summary interval"
                onChange={(selectedValue) => {
                  const value = Number(selectedValue);
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
                    {hours === 168 ? "Weekly" : hours === 24 ? "Daily" : `Every ${hours} hours`}
                  </option>
                ))}
              </SelectMenu>
            </label>
            <button
              aria-pressed={reviewSchedule.notificationsEnabled}
              className={styles.settingsLink}
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
                  ? "Check notification permission"
                  : reviewSchedule.notificationsEnabled
                    ? "Notifications on"
                    : "Enable notifications"}
            </button>
            {reviewBuiltAtUnixMs > 0 && reviewReady && (
              <span>Updated {new Date(reviewBuiltAtUnixMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
            )}
          </div>
        </div>
        <div className={styles.badges}>
          <div
            aria-atomic="true"
            aria-busy={activityState === "loading" || undefined}
            aria-label="ActivityWatch connection status"
            aria-live="polite"
            className={styles.badge}
            data-state={activityState === "loading" ? "loading" : activityConnected ? "running" : "problem"}
            data-ui="activity.connection"
            data-ui-label="Activity connection"
            role="status"
          >
            <span className={styles.badgeDot} aria-hidden="true" />
            <span>ActivityWatch · {connectionLabel}</span>
            <InfoTooltip content={activityState === "loading" ? undefined : "Check the ActivityWatch connection again"}>
              <button
                aria-label={activityState === "loading" ? "Checking…" : "Check connection"}
                className={styles.badgeButton}
                disabled={activityState === "loading"}
                onClick={() => void refreshActivityWatch()}
                type="button"
              >
                <Glyph name="refresh" size={13} />
              </button>
            </InfoTooltip>
          </div>
          <div
            className={styles.badge}
            data-state={workingAgentCount > 0 ? "working" : sessionState === "error" ? "problem" : "idle"}
            data-ui="activity.agent-badge"
            data-ui-label="Agent status"
          >
            <span className={styles.badgeDot} aria-hidden="true" />
            <span>
              {sessionState === "loading" && sessionRows.length === 0
                ? "Agents · Reading sessions…"
                : sessionState === "error"
                  ? "Agents · Unavailable"
                  : workingAgentCount > 0
                    ? `Agents · ${workingAgentCount} working`
                    : "Agents · Idle"}
            </span>
          </div>
        </div>
      </header>

      {activityProblem && (
        <div className={styles.callout} data-tone="warning" data-ui="activity.connection-help" data-ui-label="Activity connection help">
          <Glyph name="warning" size={16} />
          <div>
            <strong>
              {activityState === "error" ? "Cannot read ActivityWatch." : "ActivityWatch is not connected."}
            </strong>
            {activityState === "error" ? (
              <p>{activityError}</p>
            ) : (
              <>
                <p>{activityStatus?.detail}</p>
                <p>
                  {activityStatus?.state === "incompatible"
                    ? "Check the ActivityWatch address and API support in integrations."
                    : activityStatus?.installation === "detected"
                      ? "Start ActivityWatch, then select Check connection."
                      : "Install ActivityWatch, then start it and select Check connection."}
                </p>
              </>
            )}
            <p>Agent work continues to show below.</p>
          </div>
          {onOpenIntegrations && (
            <button className={styles.buttonSecondary} onClick={onOpenIntegrations} type="button">
              Open integrations
            </button>
          )}
        </div>
      )}

      <div
        className={styles.toolbar}
        data-ui="activity.toolbar"
        data-ui-label="My time toolbar"
        role="toolbar"
        aria-label="My time actions"
      >
        <div className={styles.periodPicker}>
          <div
            className={styles.reviewHistory}
            data-ui="activity.day-picker"
            data-ui-label="Day picker"
          >
            <span className={styles.reviewHistoryLabel}>Day</span>
            <div
              aria-label="Days"
              className={styles.reviewHistoryList}
              role="listbox"
              aria-orientation="horizontal"
            >
              {dayChoices.map((day) => {
                const selected = day.offset === 0 ? selectedIntervalId === null : selectedIntervalId === day.id;
                return (
                  <button
                    aria-selected={selected}
                    className={styles.dayChoice}
                    key={day.id}
                    onClick={() => (day.offset === 0 ? showLatestDayReview() : void showPastDay(day))}
                    onKeyDown={selectAdjacentSummary}
                    role="option"
                    tabIndex={selected ? 0 : -1}
                    type="button"
                  >
                    <strong>{day.label}</strong>
                    <span>{day.detail}</span>
                  </button>
                );
              })}
            </div>
            {reviewHistory.length > 0 && (
              <button
                aria-expanded={periodsOpen}
                className={styles.settingsLink}
                data-ui="activity.periods-toggle"
                data-ui-label="Show 4-hour periods"
                onClick={() => setShowPeriods((open) => !open)}
                type="button"
              >
                {periodsOpen ? "Hide periods" : `Periods (${reviewHistory.length})`}
              </button>
            )}
          </div>
          {periodsOpen && reviewHistory.length > 0 && (
            <div
              className={styles.reviewHistory}
              data-ui="activity.summary-history"
              data-ui-label="Activity summary history"
            >
              <span className={styles.reviewHistoryLabel}>Period</span>
              <div
                aria-label="Recent automatic summaries"
                className={styles.reviewHistoryList}
                role="listbox"
                aria-orientation="horizontal"
              >
                {reviewHistory.map((snapshot) => (
                <button
                  aria-selected={selectedIntervalId === snapshot.intervalId}
                  key={snapshot.intervalId}
                  onClick={() => showIntervalReview(snapshot)}
                  onKeyDown={selectAdjacentSummary}
                  role="option"
                  tabIndex={selectedIntervalId === snapshot.intervalId ? 0 : -1}
                  type="button"
                >
                  <strong>{intervalDateLabel(snapshot.startedAtUnixMs, snapshot.endedAtUnixMs)}</strong>
                  <span>
                    {compactDuration(snapshot.review.totalActiveSeconds)} ·{" "}
                    {snapshot.review.sessions.length}{" "}
                    {snapshot.review.sessions.length === 1 ? "block" : "blocks"}
                  </span>
                </button>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className={styles.toolbarActions}>
          {review && jiraIssues && (
            <button className={styles.buttonOutline} onClick={() => void copyAgentBrief()} type="button">
              <Glyph name={briefState === "copied" ? "check" : "copy"} size={14} />
              {briefState === "copied"
                ? "Agent brief copied"
                : briefState === "error"
                  ? "Copy failed"
                  : "Copy agent brief"}
            </button>
          )}
          {reviewState === "ready" && sessionState === "ready" && <a
            className={styles.buttonOutline}
            download={"wts-time-" + localDateKey() + ".md"}
            href={"data:text/markdown;charset=utf-8," + encodeURIComponent(buildHybridTimeExport(hybrid.summary, hybrid.range, assignments))}
            title="Save Markdown for Jira, GitHub, or Slack"
          >Export summary</a>}
          <button
            className={styles.buttonPrimary}
            disabled={reviewState === "loading" || activityStatus?.state !== "running"}
            onClick={() => void buildDailyReview()}
            type="button"
          >
            <Glyph name="refresh" size={14} />
            {reviewState === "loading"
              ? "Reading ActivityWatch…"
              : reviewState === "ready"
                ? "Refresh"
                : "Build today’s review"}
          </button>
        </div>
      </div>
      {notificationState === "denied" && (
        <p className={styles.note}>
          <Glyph name="warning" size={13} /> Notifications are blocked. Allow notifications in your browser or system settings, then select Check notification permission.
        </p>
      )}
      {notificationState === "unsupported" && <p className={styles.note}>This app cannot show notifications. Open My time to read completed summaries.</p>}


      <span aria-atomic="true" aria-live="polite" className={styles.srOnly} role="status">
        {briefState === "copied"
          ? "Agent brief copied to clipboard."
          : briefState === "error"
            ? "Agent brief could not be copied."
            : ""}
      </span>
      {briefState === "error" && agentReview && jiraIssues && (
        <label className={styles.manualCopy}>
          Clipboard access failed. Select and copy the brief below.
          <textarea aria-label="Agent brief to copy" readOnly rows={6} value={buildTimeReviewAgentBrief(agentReview, jiraIssues)} onFocus={(event) => event.currentTarget.select()} />
        </label>
      )}
      {reviewError && reviewState !== "loading" && (
        <div className={styles.callout} data-tone="error" role="alert">
          <Glyph name="warning" size={16} />
          <div>
            <strong>Daily review could not be built.</strong>
            <p>{reviewError}</p>
          </div>
        </div>
      )}

      <section
        aria-busy={reviewState === "loading" || undefined}
        aria-labelledby="daily-review-title"
        className={styles.dailyReview}
        data-ui="activity.daily-review"
        data-ui-label="Daily activity review"
      >
        <h3 className={styles.srOnly} id="daily-review-title">{periodLabel} summary</h3>
        {reviewState === "loading" && (
          <span aria-live="polite" className={styles.srOnly} role="status">
            Building today’s review…
          </span>
        )}
        <div className={styles.summaryCard}>
        <div className={styles.kpis} data-ui="activity.kpis" data-ui-label="Time summary" aria-live="polite">
          <article className={styles.kpi} data-track="user">
            <span className={styles.kpiLabel}><i aria-hidden="true" />Your active time</span>
            {(reviewState === "loading" && !review) || (reviewState === "idle" && activityState === "loading") ? (
              <span className={styles.skeleton} data-size="value" aria-hidden="true" />
            ) : (
              <strong>{reviewShown ? compactDuration(visibleReview?.totalActiveSeconds ?? 0) : "—"}</strong>
            )}
            <span className={styles.kpiDetail}>
              {reviewShown
                ? <>
                    {visibleReview?.sessions.length ?? 0}{" "}
                    {(visibleReview?.sessions.length ?? 0) === 1 ? "block" : "blocks"} from ActivityWatch{reviewState === "loading" ? " · updating…" : ""}
                  </>
                : reviewState === "loading"
                  ? "Reading ActivityWatch…"
                  : activityState === "loading"
                  ? "Checking ActivityWatch…"
                  : activityConnected
                    ? "Ready. Select Build today’s review."
                    : "Connect ActivityWatch to count your time."}
            </span>
          </article>
          <article className={styles.kpi} data-track="agent">
            <span className={styles.kpiLabel}><i aria-hidden="true" />Agent active time</span>
            {sessionState === "loading" && sessionRows.length === 0 ? (
              <span className={styles.skeleton} data-size="value" aria-hidden="true" />
            ) : (
              <strong>{formatDuration(shownAgentMs)}</strong>
            )}
            <span className={styles.kpiDetail}>
              {summary.agentBlocks.length === 0
                ? "No agent work is recorded for this period."
                : agentTimeDetail(summary.agentBlocks)}
            </span>
          </article>
          <article className={styles.kpi} data-track="multiplier">
            <span className={styles.kpiLabel}><i aria-hidden="true" />Agent multiplier</span>
            {reviewState === "loading" && !review ? (
              <span className={styles.skeleton} data-size="value" aria-hidden="true" />
            ) : (
              <strong>{summary.multiplier === null || !reviewShown ? "—" : `${summary.multiplier.toFixed(1)}×`}</strong>
            )}
            <span className={styles.kpiDetail}>
              {summary.multiplier === null || !reviewShown
                ? summary.agentMs > 0
                  ? reviewState === "loading" ? "Calculating the ratio…" : `Agents worked ${formatDuration(shownAgentMs)}. Your time is not loaded.`
                  : "Agent work for each hour of your time."
                : `Agents worked ${formatDuration(shownAgentMs)} for each ${formatDuration(shownUserMs)} of your time.`}
            </span>
          </article>
        </div>
        <div className={styles.kpiFooter} data-ui="activity.total" data-ui-label="Total time">
          <span
            aria-hidden="true"
            className={styles.kpiBar}
            style={{ "--user-share": `${shownUserMs + shownAgentMs > 0 ? (shownUserMs / (shownUserMs + shownAgentMs)) * 100 : 50}%` } as CSSProperties}
          />
          {reviewState === "loading" && !review ? (
            <span>Calculating the total…</span>
          ) : reviewShown ? (
            <span>
              Total <strong>{formatDuration(shownUserMs + shownAgentMs)}</strong>
              <span className={styles.kpiFormula}>{formatDuration(shownUserMs)} you + {formatDuration(shownAgentMs)} agents</span>
              {summary.multiplier !== null && (
                <span className={styles.kpiFormula}>{formatDuration(shownAgentMs)} ÷ {formatDuration(shownUserMs)} = {summary.multiplier.toFixed(1)}×</span>
              )}
              <span>
                {summary.overlapMs > 0
                  ? "Overlapping activity windows can include short idle gaps."
                  : "No overlapping activity windows."}
              </span>
            </span>
          ) : (
            <span>Your time plus agent time shows here after the review loads.</span>
          )}
        </div>
      </div>

        <section
          aria-label="Activity overview"
          className={styles.timelineCard}
          data-ui="activity.timeline"
          data-ui-label="Time timeline"
        >
          <header className={styles.cardHeader}>
            <div>
              <h3>Timeline</h3>
              <span>{periodLabel} · {activityRangeLabel(windowSpan.startedAtUnixMs, windowSpan.endedAtUnixMs)}</span>
            </div>
            <ul className={styles.legend} aria-label="Timeline legend">
              <li data-track="user">You</li>
              <li data-track="agent">Agents</li>
              <li data-track="overlap">Overlapping windows{summary.overlapMs > 0 ? ` · ${formatDuration(summary.overlapMs)}` : ""}</li>
            </ul>
          </header>
          <div className={styles.timeline}>
            <div className={styles.axis} aria-hidden="true">
              <span />
              <div className={styles.axisTicks}>
                {ticks.map((tick) => (
                  <span key={tick} style={{ "--tick-left": `${place(tick, tick).left}%` } as CSSProperties}>
                    {new Date(tick).toLocaleTimeString([], { hour: "numeric" })}
                  </span>
                ))}
              </div>
            </div>
            <div className={styles.lanes}>
              <div className={styles.overlayLayer} aria-hidden="true">
                {ticks.map((tick) => (
                  <span className={styles.gridLine} key={tick} style={{ "--tick-left": `${place(tick, tick).left}%` } as CSSProperties} />
                ))}
                {nowPosition !== null && selectedIntervalId === null && (
                  <span className={styles.nowLine} style={{ "--tick-left": `${nowPosition}%` } as CSSProperties} />
                )}
              </div>
              <div className={styles.lane} data-track="user">
                <span className={styles.laneLabel}>You</span>
                {(reviewState === "loading" && !review) || (reviewState === "idle" && activityState === "loading") ? (
                  <span className={styles.skeleton} data-size="lane" aria-hidden="true" />
                ) : summary.userBlocks.length === 0 ? (
                  <span className={styles.laneEmpty}>
                    {reviewReady
                      ? "No active time in this period."
                      : activityState === "loading"
                        ? "Checking ActivityWatch…"
                        : activityConnected
                          ? "Today’s data is not loaded."
                          : "Connect ActivityWatch to show your time."}
                    {!reviewReady && activityConnected && reviewState !== "loading" && (
                      <button className={styles.laneAction} onClick={() => void buildDailyReview()} type="button">
                        Build review
                      </button>
                    )}
                  </span>
                ) : (
                  <ol aria-label="Daily activity timeline" className={styles.laneTrack}>
                    {userGroups.map((group) => {
                      const position = place(group.startedAtUnixMs, group.endedAtUnixMs);
                      const first = group.items[0]!;
                      const single = group.items.length === 1;
                      const apps = topByDuration(group.items, (item) => item.application);
                      const label = single ? first.application : `${group.items.length} blocks`;
                      return (
                        <li
                          key={group.id}
                          style={{ "--activity-left": `${position.left}%`, "--activity-width": `${position.width}%` } as CSSProperties}
                        >
                          <InfoTooltip
                            content={
                              <span className={styles.tip}>
                                <strong>{activityRangeLabel(group.startedAtUnixMs, group.endedAtUnixMs)} · {formatDuration(group.durationMs)} active</strong>
                                <span>{single ? first.application : `${group.items.length} activity blocks in ${formatDuration(group.endedAtUnixMs - group.startedAtUnixMs)}`}</span>
                                {single ? <span>{first.detail}</span> : (
                                  <>
                                    <span className={styles.tipSection}>Longest work</span>
                                    {[...group.items].sort((a, b) => b.durationMs - a.durationMs).slice(0, 3).map((item) => (
                                      <span key={item.id}>{formatDuration(item.durationMs)} · {item.detail}</span>
                                    ))}
                                    <span className={styles.tipSection}>Applications</span>
                                    <span>{apps.slice(0, 4).map((app) => `${app.name} ${formatDuration(app.durationMs)}`).join(" · ")}</span>
                                  </>
                                )}
                                {single && first.jiraIssueKey && <span>{first.jiraIssueKey}</span>}
                              </span>
                            }
                          >
                            <span
                              aria-label={`${label}, ${formatDuration(group.durationMs)}`}
                              className={styles.block}
                              data-kind={single || apps.length === 1 ? first.kind : "mixed"}
                              role="img"
                              tabIndex={0}
                            />
                          </InfoTooltip>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </div>
              <div className={styles.lane} data-track="agent">
                <span className={styles.laneLabel}>Agents</span>
                {sessionState === "loading" && sessionRows.length === 0 ? (
                  <span className={styles.skeleton} data-size="lane" aria-hidden="true" />
                ) : summary.agentBlocks.length === 0 ? (
                  <span className={styles.laneEmpty}>No agent work in this period.</span>
                ) : (
                  <ol aria-label="Agent work timeline" className={styles.laneTrack}>
                    {agentGroups.map((group) => {
                      const position = place(group.startedAtUnixMs, group.endedAtUnixMs);
                      const first = group.items[0]!;
                      const single = group.items.length === 1;
                      const ongoing = group.items.some((item) => item.ongoing);
                      const workspaces = topByDuration(group.items, (item) => {
                        if (item.source === "outsideWorkspace") return item.chatLabel ?? "Chat outside a workspace";
                        const workspace = workspaceLabels[item.workspaceId];
                        return workspace ? workspaceDisplayName(workspace) : "Unassigned workspace";
                      });
                      const providers = [...new Set(group.items.map((item) => item.providerLabel))].join(", ");
                      return (
                        <li
                          key={group.id}
                          style={{ "--activity-left": `${position.left}%`, "--activity-width": `${position.width}%` } as CSSProperties}
                        >
                          <InfoTooltip
                            content={
                              <span className={styles.tip}>
                                <strong>{single ? `${first.providerLabel} · ${first.source === "vsCode" ? "VS Code" : first.source === "terminal" ? "Terminal" : "Outside workspaces"}` : `${providers} · ${group.items.length} turns`}</strong>
                                {single ? (
                                  <span>{formatDuration(group.durationMs)}{ongoing ? " so far" : ""} · {activityRangeLabel(group.startedAtUnixMs, group.endedAtUnixMs)}</span>
                                ) : (
                                  <>
                                    <span>{formatDuration(group.durationMs)} agent work{ongoing ? " so far" : ""} · {formatDuration(agentClockMs(group.items))} on the clock</span>
                                    <span>{activityRangeLabel(group.startedAtUnixMs, group.endedAtUnixMs)}</span>
                                  </>
                                )}
                                {single && <span>{first.detail}</span>}
                                {workspaces.slice(0, 3).map((workspace) => <span key={workspace.name}>{workspace.name}</span>)}
                              </span>
                            }
                          >
                            <span
                              aria-label={`${providers} agent, ${formatDuration(group.durationMs)}`}
                              className={styles.block}
                              data-kind="agentWork"
                              data-ongoing={ongoing || undefined}
                              role="img"
                              tabIndex={0}
                            />
                          </InfoTooltip>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </div>
              <div className={styles.lane} data-track="overlap">
                <span className={styles.laneLabel}>Both</span>
                <ol aria-label="Overlapping activity windows" className={styles.laneTrack}>
                  {overlapGroups.map((group) => {
                    const position = place(group.startedAtUnixMs, group.endedAtUnixMs);
                    return (
                      <li key={group.id} style={{ "--activity-left": `${position.left}%`, "--activity-width": `${position.width}%` } as CSSProperties}>
                        <InfoTooltip
                          content={
                            <span className={styles.tip}>
                              <strong>Overlapping user and agent windows</strong>
                              <span>{formatDuration(group.durationMs)} · {activityRangeLabel(group.startedAtUnixMs, group.endedAtUnixMs)}</span>
                            </span>
                          }
                        >
                          <span
                            aria-label={`Overlapping windows, ${formatDuration(group.durationMs)}`}
                            className={styles.block}
                            data-kind="overlap"
                            role="img"
                            tabIndex={0}
                          />
                        </InfoTooltip>
                      </li>
                    );
                  })}
                </ol>
              </div>
            </div>
          </div>
        </section>

        <div className={styles.columns}>
          <section className={styles.card} aria-labelledby="activity-blocks-title">
            <header className={styles.cardHeader}>
              <div>
                <h3 id="activity-blocks-title">Activity blocks</h3>
                <span>
                  {reviewReady
                    ? `${visibleReview?.sessions.length ?? 0} ${(visibleReview?.sessions.length ?? 0) === 1 ? "block" : "blocks"} · ${compactDuration(visibleReview?.totalActiveSeconds ?? 0)}`
                    : "Assign your work to Jira tickets"}
                </span>
              </div>
              {ignoredSessionCount > 0 && (
                <button
                  className={styles.buttonGhost}
                  onClick={() => setShowIgnoredApplications((current) => !current)}
                  type="button"
                >
                  {showIgnoredApplications ? "Hide ignored" : `${ignoredSessionCount} ignored`}
                </button>
              )}
            </header>
            {reviewReady && jiraState !== "ready" && (
              <div
                aria-atomic="true"
                aria-busy={jiraState === "loading" || undefined}
                aria-live="polite"
                className={styles.jiraContext}
                data-state={jiraState}
                role="status"
              >
                <strong>{jiraState === "loading" ? "Loading Jira tickets…" : "Jira tickets are unavailable"}</strong>
                {jiraState === "error" && <span>{jiraError}</span>}
                {jiraState === "error" && (
                  <span className={styles.inlineActions}>
                    <button className={styles.buttonSecondary} onClick={() => void retryJiraIssues()} type="button">Retry Jira tickets</button>
                    {onOpenIntegrations && <button className={styles.buttonGhost} onClick={onOpenIntegrations} type="button">Open integrations</button>}
                  </span>
                )}
              </div>
            )}
            {reviewState === "loading" && !review && (
              <div className={styles.skeletonList} aria-hidden="true">
                <span className={styles.skeleton} data-size="row" />
                <span className={styles.skeleton} data-size="row" />
                <span className={styles.skeleton} data-size="row" />
              </div>
            )}
            {reviewState === "idle" && activityState === "loading" && (
              <div className={styles.skeletonList} aria-hidden="true">
                <span className={styles.skeleton} data-size="row" />
                <span className={styles.skeleton} data-size="row" />
              </div>
            )}
            {reviewState === "idle" && activityState !== "loading" && (
              <div className={styles.empty}>
                <strong>No activity yet.</strong>
                <span>
                  {activityConnected
                    ? "Select Build today’s review. ActivityWatch is read on this computer only."
                    : "Connect ActivityWatch. Then build the review to see your work blocks."}
                </span>
              </div>
            )}
            {reviewState === "error" && !review && (
              <div className={styles.empty}>
                <strong>No review is available.</strong>
                <span>Select Build today’s review to try again.</span>
              </div>
            )}
            {reviewReady && (visibleReview?.sessions.length ?? 0) === 0 && (
              <div className={styles.empty}>
                <strong>{ignoredSessionCount > 0 ? "All current activity is ignored." : "No active work found for today."}</strong>
                {ignoredSessionCount > 0 && <span>Review ignored applications to include a block again.</span>}
              </div>
            )}
            {reviewReady && workGroups.length > 0 && (
              <section
                aria-labelledby="jira-groups-title"
                className={styles.jiraGroups}
                data-ui="activity.jira-groups"
                data-ui-label="Suggested Jira groups"
              >
                <header>
                  <h4 id="jira-groups-title">Suggested Jira groups</h4>
                  <span>
                    Blocks that match one ticket. Show the blocks to check them. Set Jira fills the Jira field of each block
                    and adds the time to that ticket in Export summary. Nothing goes to Jira.
                  </span>
                </header>
                <ul>
                  {workGroups.map((group) => {
                    const members = group.sessionIds
                      .map((id) => visibleReview?.sessions.find((session) => session.id === id))
                      .filter((session) => session !== undefined);
                    return (
                      <li key={group.issueKey}>
                        <div className={styles.jiraGroupRow}>
                          <div className={styles.jiraGroupText}>
                            <strong title={group.issueSummary}>
                              {group.issueKey} · {group.issueSummary}
                            </strong>
                            <span>
                              {pluralize(group.sessionIds.length, "block")} · {compactDuration(group.totalSeconds)} · {group.reason}
                            </span>
                          </div>
                          <div className={styles.inlineActions}>
                            <button
                              aria-label={`Set Jira to ${group.issueKey} on ${pluralize(group.sessionIds.length, "block")}`}
                              className={styles.buttonSecondary}
                              onClick={() => assignGroup(group.sessionIds, group.issueKey)}
                              type="button"
                            >
                              Set Jira on {pluralize(group.sessionIds.length, "block")}
                            </button>
                            <button
                              aria-label={`Dismiss the ${group.issueKey} suggestion`}
                              className={styles.buttonGhost}
                              onClick={() => setDismissedGroups((current) => new Set(current).add(group.issueKey))}
                              type="button"
                            >
                              Dismiss
                            </button>
                          </div>
                        </div>
                        <details className={styles.jiraGroupMembers}>
                          <summary>Show the {pluralize(members.length, "block")}</summary>
                          <ul aria-label={`Blocks suggested for ${group.issueKey}`}>
                            {members.map((session) => (
                              <li key={session.id}>
                                <span>{session.activityEvidence ?? session.description}</span>
                                <span>
                                  {session.application ?? ""} · {new Date(session.startedAtUnixMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · {compactDuration(session.durationSeconds)}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </details>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
            {reviewReady && (visibleReview?.sessions.length ?? 0) > 0 && (
              <h4 className={styles.reviewListHeading} id="activity-list-title">
                All blocks
              </h4>
            )}
            {reviewReady && (visibleReview?.sessions.length ?? 0) > 0 && (
              <ol
                aria-label="Today’s ActivityWatch review"
                className={styles.reviewList}
                data-ui="activity.review-list"
                data-ui-label="Daily activity list"
              >
                {visibleReview?.sessions.map((session) => {
                  const applicationIgnored = isApplicationIgnored(session.application, ignoredApplications);
                  const suggestions = suggestJiraIssues(session, jiraIssues?.issues ?? []);
                  const selectedKey = assignments[session.id] ?? suggestions[0]?.issueKey ?? "";
                  const selectedIssue = jiraIssues?.issues.find((issue) => issue.issueKey === selectedKey);
                  const selectedSuggestion = suggestions.find((suggestion) => suggestion.issueKey === selectedKey);
                  const title = session.activityEvidence ?? session.description;
                  const expanded = expandedBlocks.has(session.id);
                  const detailsId = `activity-block-${session.id}`;
                  return (
                    <li data-expanded={expanded || undefined} key={session.id}>
                      <div className={styles.blockRow}>
                        <button
                          aria-controls={detailsId}
                          aria-expanded={expanded}
                          aria-label={`${expanded ? "Hide" : "Show"} details for ${title}`}
                          className={styles.expandButton}
                          onClick={() => toggleBlock(session.id)}
                          type="button"
                        >
                          <Glyph name="chevron" size={14} />
                        </button>
                        <span className={styles.kindMark} data-kind={session.kind} aria-hidden="true" />
                        <div className={styles.reviewIdentity}>
                          <button
                            aria-controls={detailsId}
                            aria-expanded={expanded}
                            className={styles.titleButton}
                            onClick={() => toggleBlock(session.id)}
                            tabIndex={-1}
                            type="button"
                          >
                            {title}
                          </button>
                          <span className={styles.tags}>
                            <span className={styles.tag} data-kind={session.kind}>#{session.kind === "agent" ? "agent-task" : session.kind}</span>
                            {selectedKey && <span className={styles.tag} data-kind="jira">#{selectedKey.toLowerCase()}</span>}
                            <span className={styles.tagMuted}>{session.application ?? "Unknown application"}</span>
                            {session.application && (
                              <button
                                aria-label={`${applicationIgnored ? "Include" : "Ignore"} activity from ${session.application}`}
                                className={styles.linkButton}
                                onClick={() => updateIgnoredApplication(session.application!, !applicationIgnored)}
                                type="button"
                              >
                                {applicationIgnored ? "Include application" : "Ignore application"}
                              </button>
                            )}
                          </span>
                        </div>
                        <div className={styles.blockTime}>
                          <strong>{compactDuration(session.durationSeconds)}</strong>
                          <time dateTime={new Date(session.startedAtUnixMs).toISOString()}>
                            {new Date(session.startedAtUnixMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                          </time>
                        </div>
                        <label className={styles.assignment}>
                          <span>
                            Jira{selectedSuggestion ? ` · ${selectedSuggestion.confidence}% match` : ""}
                          </span>
                          <SelectMenu
                            aria-label={`Jira ticket for ${title}`}
                            disabled={jiraState !== "ready"}
                            onChange={(value) => setAssignments((current) => ({ ...current, [session.id]: value }))}
                            value={selectedKey}
                          >
                            <option value="">Unassigned</option>
                            {(jiraIssues?.issues ?? []).map((issue) => (
                              <option key={issue.issueKey} value={issue.issueKey}>
                                {issue.issueKey} · {issue.summary}
                              </option>
                            ))}
                          </SelectMenu>
                          {(selectedSuggestion || selectedIssue) && (
                            <small>{selectedSuggestion?.reason ?? selectedIssue?.status}</small>
                          )}
                        </label>
                      </div>
                      {expanded && (
                        <div className={styles.blockDetails} id={detailsId}>
                          <dl>
                            <div><dt>Time</dt><dd>{activityRangeLabel(session.startedAtUnixMs, session.endedAtUnixMs)}</dd></div>
                            <div><dt>Application</dt><dd>{session.application ?? "Unknown application"}</dd></div>
                            <div><dt>Summary</dt><dd>{session.description}</dd></div>
                            <div><dt>Jira</dt><dd>{selectedIssue ? `${selectedIssue.issueKey} · ${selectedIssue.summary} (${selectedIssue.status})` : "Unassigned"}</dd></div>
                          </dl>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
          </section>

          <aside className={styles.sideColumn}>
            {reviewReady && applicationSummary.length > 0 && (
              <section className={styles.card} aria-labelledby="applications-title">
                <header className={styles.cardHeader}>
                  <div>
                    <h3 id="applications-title">Applications</h3>
                    <span>Active time</span>
                  </div>
                </header>
                <ol aria-label="Application activity totals" className={styles.applicationList}>
                  {applicationSummary.map((application) => {
                    const share = (visibleReview?.totalActiveSeconds ?? 0) > 0
                      ? Math.min(100, (application.durationSeconds / visibleReview!.totalActiveSeconds) * 100)
                      : 0;
                    return (
                      <li key={application.application}>
                        <strong>{application.application}</strong>
                        <span>{compactDuration(application.durationSeconds)}</span>
                        <span className={styles.shareBar} aria-hidden="true">
                          <span style={{ "--share": `${share}%` } as CSSProperties} />
                        </span>
                      </li>
                    );
                  })}
                </ol>
              </section>
            )}

            <section className={styles.card} aria-labelledby="agent-sessions-heading">
              <header
                className={styles.cardHeader}
                data-ui="activity.agent-sessions-header"
                data-ui-label="Agent sessions header"
              >
                <div>
                  <h3 id="agent-sessions-heading">Agent sessions</h3>
                  <span aria-live="polite">
                    {openRecordCount} open · {automaticRefreshPaused ? "refresh paused" : "refreshes every 5 seconds"}
                  </span>
                </div>
                <button
                  className={styles.buttonGhost}
                  disabled={sessionState === "loading"}
                  onClick={() => { setRefreshCount(0); void refreshSessions(true, true); }}
                  type="button"
                >
                  <Glyph name="refresh" size={14} />
                  Refresh sessions
                </button>
              </header>
              <div aria-busy={sessionState === "loading" || undefined}>
                {sessionState === "loading" && (
                  <div className={styles.skeletonList} role="status" aria-label="Reading managed sessions…">
                    <span className={styles.skeleton} data-size="row" />
                    <span className={styles.skeleton} data-size="row" />
                  </div>
                )}
                {sessionState === "error" && (
                  <div className={styles.callout} data-tone="error" role="alert">
                    <Glyph name="warning" size={16} />
                    <div>
                      <strong>Session history could not be loaded.</strong>
                      <p>{sessionError}</p>
                    </div>
                    <button className={styles.buttonSecondary} onClick={() => void refreshSessions(true, true)} type="button">
                      Try again
                    </button>
                  </div>
                )}
                {sessionState === "ready" && sessionRows.length === 0 && (
                  <div className={styles.empty}>
                    <strong>No agent sessions are visible.</strong>
                    <span>Start a WTS background task or open Codex in a saved VS Code workspace. The session will appear here.</span>
                  </div>
                )}
                {sessionState === "ready" && sessionRows.length > 0 && (
                  <ol
                    aria-label="Current and recent agent sessions"
                    className={styles.list}
                    data-ui="activity.agent-sessions-list"
                    data-ui-label="Agent sessions list"
                  >
                    {shownSessionRows.map((row) => {
                      if (row.kind === "observed") {
                        const session = row.session;
                        const workspace = workspaceLabels[session.workspaceId];
                        const provider = session.provider === "copilot" ? "GitHub Copilot" : "Codex";
                        const status = session.status === "working" ? "running" : session.status;
                        const worked = agentWorkBySession.get(session.sessionId);
                        return (
                          <li key={`observed-${session.sessionId}`}>
                            <span
                              aria-label={session.status === "working" ? `${provider} is working` : `${provider} is open in VS Code`}
                              className={styles.statusDot}
                              data-status={status}
                            />
                            <div className={styles.sessionIdentity}>
                              <span className={styles.sessionTitle}>
                                <strong>{provider}</strong>
                                <span className={styles.status} data-status={status}>
                                  {session.status === "working" ? "Working in VS Code" : "Open in VS Code"}
                                </span>
                              </span>
                              <span>VS Code · {session.model ?? "Provider-selected model"}</span>
                              <span className={styles.sessionWorkspace}>
                                <strong>{workspace?.key ?? "Unassigned workspace"}</strong>
                                <span>{workspace?.title ?? `No saved workspace matches ${session.workspaceId}`}</span>
                              </span>
                            </div>
                            <div className={styles.sessionTiming}>
                              <strong>{worked ? formatDuration(worked) : session.activity ? session.activity.replace(/([A-Z])/g, " $1").toLowerCase() : "No activity detail"}</strong>
                              {worked && session.activity && <span>{session.activity.replace(/([A-Z])/g, " $1").toLowerCase()}</span>}
                              <time dateTime={new Date(session.lastEventAtUnixMs).toISOString()}>
                                {new Date(session.lastEventAtUnixMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                              </time>
                            </div>
                          </li>
                        );
                      }
                      const session = row.session;
                      const failure = failureLabel(session.failure);
                      const workspace = workspaceLabels[session.workspaceId];
                      return (
                        <li key={session.sessionId}>
                          <span aria-label={statusLabels[session.status]} className={styles.statusDot} data-status={session.status} />
                          <div className={styles.sessionIdentity}>
                            <span className={styles.sessionTitle}>
                              <strong>{providerLabels[session.provider]}</strong>
                              <span className={styles.status} data-status={session.status}>
                                {failure ?? statusLabels[session.status]}
                              </span>
                            </span>
                            <span>{session.terminal === "warp" ? "Warp" : "Terminal"} · {categoryLabel(session.category)}</span>
                            <span className={styles.sessionWorkspace}>
                              <strong>{workspace?.key ?? "Unassigned workspace"}</strong>
                              <span>{workspace?.title ?? `No saved workspace matches ${session.workspaceId}`}</span>
                            </span>
                          </div>
                          <div className={styles.sessionTiming}>
                            <strong>{durationLabel(session, now)}</strong>
                            <time dateTime={new Date(session.startedAtUnixMs).toISOString()}>
                              {new Date(session.startedAtUnixMs).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                            </time>
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                )}
                {sessionState === "ready" && sessionRows.length > visibleSessionLimit && (
                  <button className={styles.showMore} onClick={() => setShowAllSessions((current) => !current)} type="button">
                    {showAllSessions ? "Show fewer sessions" : `Show all ${sessionRows.length} sessions`}
                  </button>
                )}
              </div>
            </section>
          </aside>
        </div>
      </section>
    </section>
  );
}
